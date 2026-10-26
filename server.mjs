import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_FILE = path.join(__dirname, "server.log");
const PORT = 8765;

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_FILE, line + "\n", "utf8");
  } catch (e) {}
}

let globalTask = null;
let globalPage = null;
let isReady = false;
let initError = null;

const requestQueue = [];
let isProcessing = false;

// 1. 初始化常驻 ChatGPT 会话
async function initBrowserSession() {
  try {
    isReady = false;
    const spaceId = `ChatGPT-Bridge-${Date.now().toString(36)}`;
    log(`[EgoBridge] 正在建立常驻任务空间: ${spaceId} ...`);
    globalTask = await taskSpace(spaceId);
    globalPage = await globalTask.newPage();
    
    log("[EgoBridge] 导航至 https://chatgpt.com ...");
    await globalPage.goto("https://chatgpt.com", { timeout: 45000, waitUntil: "domcontentloaded" });
    
    log("[EgoBridge] 等待 Sentinel 安全握手就绪 (6秒)...");
    await globalPage.waitForTimeout(6000);
    
    // 确保输入框存在
    await globalPage.waitForSelector('div[role="textbox"]', { timeout: 15000 });
    
    isReady = true;
    initError = null;
    log("[EgoBridge] ChatGPT 常驻会话已完全就绪，开始接客！");
  } catch (err) {
    log(`[EgoBridge] 会话初始化失败: ${err.message}`);
    initError = err.message;
    isReady = false;
  }
}

// 确保页面和会话处于活跃状态（自愈机制）
async function ensureSessionReady() {
  if (globalPage && isReady) {
    try {
      await globalPage.evaluate(() => 1);
      return;
    } catch (err) {
      log(`[EgoBridge] 现有会话已失效，正在自动拉起新会话... (${err.message})`);
    }
  }
  await initBrowserSession();
  if (!isReady) {
    throw new Error("ChatGPT 会话无法就绪: " + (initError || "未知异常"));
  }
}

// 精准多段落/富文本无障碍树抽取器
function extractAssistantReply(snapshot, userPrompt) {
  // 1. 定位最后一个用户消息标记（每个用户消息下方都有“编辑消息”或“复制消息”按钮）
  const editMarkers = ['button "编辑消息"', 'button "共享提示"', 'button "复制消息"'];
  let lastUserMsgEnd = -1;
  for (const marker of editMarkers) {
    const pos = snapshot.lastIndexOf(marker);
    if (pos > lastUserMsgEnd) lastUserMsgEnd = pos;
  }

  // 回退：如果没找到编辑按钮，尝试找用户 prompt
  if (lastUserMsgEnd === -1 && userPrompt) {
    const pIdx = snapshot.lastIndexOf(`text "${userPrompt}"`);
    if (pIdx !== -1) lastUserMsgEnd = pIdx;
  }

  let relevantSnap = lastUserMsgEnd !== -1
    ? snapshot.slice(lastUserMsgEnd)
    : snapshot;

  // 2. 截取到本轮回答结束的控制栏（button "重新生成回复" 之前）
  const regenPos = relevantSnap.indexOf('button "重新生成回复"');
  if (regenPos !== -1) {
    relevantSnap = relevantSnap.slice(0, regenPos);
  }

  const lines = relevantSnap.split('\n');
  const blocks = [];
  let currentBlock = [];
  let inButton = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (/^\s*button\b/.test(line)) {
      inButton = true;
      continue;
    }
    if (/^\s*(container|paragraph|heading|listitem|code)\b/.test(line)) {
      inButton = false;
    }

    if (trimmed.startsWith('paragraph') || trimmed.startsWith('heading') || trimmed.startsWith('listitem') || trimmed.startsWith('code')) {
      if (currentBlock.length > 0) {
        blocks.push(currentBlock.join(''));
        currentBlock = [];
      }
    }

    if (!inButton && trimmed.startsWith('text "') && trimmed.endsWith('"')) {
      const val = trimmed.slice(6, -1);
      const ignore = [
        '复制消息', '共享提示', '编辑消息', '复制', '评价回复', '朗读', '分享',
        '重新生成回复', '更多操作', '来源', 'ChatGPT 可能会出错。请核查重要信息。', '查看来源',
        '已复制代码', '代码', '滚动到底部', '询问 ChatGPT', '正在思考', '思考过程'
      ];
      if (ignore.includes(val) || (userPrompt && val === userPrompt)) continue;
      currentBlock.push(val);
    }
  }

  if (currentBlock.length > 0) {
    blocks.push(currentBlock.join(''));
  }

  return blocks.filter(Boolean).join('\n\n').trim();
}

// 2. 核心问答调度（集成工具访问自动授权与状态机监听）
async function askChatGPT(prompt) {
  await ensureSessionReady();
  
  log(`[EgoBridge] 开始处理提问: "${prompt.slice(0, 30)}..."`);
  
  // 步骤 A: 定位输入框并清空内容
  await globalPage.waitForSelector('div[role="textbox"]', { timeout: 15000 });
  await globalPage.click('div[role="textbox"]');
  await globalPage.waitForTimeout(300);
  await globalPage.keyboard.press("Control+A");
  await globalPage.keyboard.press("Backspace");
  await globalPage.waitForTimeout(300);
  
  // 步骤 B: 键入提示词
  await globalPage.keyboard.insertText(prompt);
  
  // 步骤 C: 等待发送按钮就绪
  for (let i = 0; i < 20; i++) {
    const isAvailable = await globalPage.evaluate(() => {
      const btn = document.querySelector('button[aria-label="发送"]');
      return btn && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true';
    });
    if (isAvailable) break;
    await globalPage.waitForTimeout(300);
  }
  
  // 步骤 D: 点击发送
  await globalPage.click('button[aria-label="发送"]');
  log("[EgoBridge] 已点击发送，等待模型响应生成...");
  
  // 步骤 E: 轮询等待生成完成（先检测停止按钮出现，再检测停止按钮消失且重新生成按钮出现）
  const startTime = Date.now();
  let hasStarted = false;
  let hasAuthorizedTool = false;
  
  while (Date.now() - startTime < 120000) {
    await globalPage.waitForTimeout(1000);
    
    // 1. 自动处理 Cloudflare Challenge
    const isCf = await globalPage.evaluate(() => {
      return document.body.innerText.includes('cloudflare_challenge');
    });
    if (isCf) {
      log("[EgoBridge] 遇到 Cloudflare Challenge，尝试点击重试...");
      try {
        await globalPage.click('role:button[name="重试"], button:has-text("重试")');
        await globalPage.waitForTimeout(3000);
      } catch(e) {}
    }
    
    // 2. 自动检测并处理工具/Action 访问授权（如 Raccoon Connection 权限请求）
    const authAction = await globalPage.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      // 优先“始终允许”
      const allowAlways = buttons.find(b => b.innerText && (b.innerText.includes('始终允许') || b.innerText.includes('Always allow')) && !b.disabled);
      if (allowAlways) {
        const text = allowAlways.innerText.trim();
        allowAlways.click();
        return { clicked: text, type: "always" };
      }
      // 其次“允许一次”或“允许”或“确认”
      const allowOnce = buttons.find(b => b.innerText && (b.innerText.includes('允许一次') || b.innerText.trim() === '允许' || b.innerText.includes('Allow once') || b.innerText.trim() === 'Allow' || b.innerText.includes('确认')) && !b.disabled);
      if (allowOnce) {
        const text = allowOnce.innerText.trim();
        allowOnce.click();
        return { clicked: text, type: "once" };
      }
      return null;
    });
    
    if (authAction) {
      hasAuthorizedTool = true;
      log(`[EgoBridge] [权限拦截] 侦测到 ChatGPT 访问授权请求，已默认自动同意并点击: "${authAction.clicked}"`);
      await globalPage.waitForTimeout(1500);
    }
    
    const status = await globalPage.evaluate(() => {
      const stop = document.querySelector('button[aria-label="停止"]');
      const regen = document.querySelector('button[aria-label="重新生成回复"]');
      return {
        generating: !!stop,
        regen: !!regen
      };
    });
    
    if (status.generating) {
      hasStarted = true;
    }
    
    // 如果开始生成后，停止按钮消失且重新生成回复按钮出现，说明本轮彻底完成
    if (hasStarted && !status.generating && status.regen) {
      log("[EgoBridge] 模型回答生成完毕！");
      break;
    }
  }
  
  await globalPage.waitForTimeout(1200);
  
  // 步骤 F: 从 Accessibility Snapshot 提取干净完整的全量回答文本
  const snap = await globalPage.snapshot();
  let replyText = extractAssistantReply(snap, prompt);
  
  // DOM 回退提取机制
  if (!replyText) {
    replyText = await globalPage.evaluate((userPrompt) => {
      const ps = Array.from(document.querySelectorAll('div[role="region"] p, main p'))
        .map(p => p.innerText.trim())
        .filter(t => t && t !== '询问 ChatGPT' && !t.includes('ChatGPT 可能会出错') && t !== userPrompt);
      return ps.length > 0 ? ps[ps.length - 1] : "";
    }, prompt);
  }
  
  log(`[EgoBridge] 最终提取完整回答 (${replyText.length} 字符): "${replyText.slice(0, 50)}..."`);
  return replyText || "（未能提取到回复，请重试）";
}

// 3. 队列调度处理器
async function processQueue() {
  if (isProcessing || requestQueue.length === 0) return;
  isProcessing = true;
  const { prompt, stream, res } = requestQueue.shift();
  
  try {
    const reply = await askChatGPT(prompt);
    const created = Math.floor(Date.now() / 1000);
    const id = "chatcmpl-" + Math.random().toString(36).substring(2, 12);
    
    if (stream) {
      // 标准 OpenAI SSE 流式输出
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive"
      });
      
      // 平滑流式逐字打字机推送
      const chunkSize = 4;
      for (let i = 0; i < reply.length; i += chunkSize) {
        const deltaContent = reply.slice(i, i + chunkSize);
        const chunk = {
          id,
          object: "chat.completion.chunk",
          created,
          model: "chatgpt-plus",
          choices: [{ index: 0, delta: { role: "assistant", content: deltaContent }, finish_reason: null }]
        };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        await new Promise(r => setTimeout(r, 20));
      }
      
      const doneChunk = {
        id,
        object: "chat.completion.chunk",
        created,
        model: "chatgpt-plus",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }]
      };
      res.write(`data: ${JSON.stringify(doneChunk)}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    } else {
      // 标准 OpenAI JSON 响应
      const payload = {
        id,
        object: "chat.completion",
        created,
        model: "chatgpt-plus",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: reply },
            finish_reason: "stop"
          }
        ],
        usage: {
          prompt_tokens: prompt.length,
          completion_tokens: reply.length,
          total_tokens: prompt.length + reply.length
        }
      };
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(payload, null, 2));
    }
  } catch (err) {
    log(`[EgoBridge] 处理异常: ${err.message}`);
    res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: { message: err.message, type: "server_error" } }));
  } finally {
    isProcessing = false;
    processQueue();
  }
}

// 4. HTTP 服务器定义
const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  
  if (req.method === "OPTIONS") {
    res.writeHead(200);
    res.end();
    return;
  }
  
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  
  // 健康状态
  if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/")) {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({
      status: isReady ? "ready" : (initError ? "error" : "initializing"),
      initError,
      message: "ChatGPT OpenAI Bridge is online and ready",
      port: PORT
    }));
    return;
  }
  
  // 最新日志实时端点 (GET /logs)
  if (req.method === "GET" && url.pathname === "/logs") {
    let logs = "";
    try {
      logs = fs.existsSync(LOG_FILE) ? fs.readFileSync(LOG_FILE, "utf8") : "暂无日志";
    } catch (e) { logs = e.message; }
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(logs);
    return;
  }
  
  // 模型列表（兼容 /models 和 /v1/models）
  if (req.method === "GET" && (url.pathname === "/v1/models" || url.pathname === "/models")) {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({
      object: "list",
      data: [
        { id: "chatgpt-plus", object: "model", created: 1715367049, owned_by: "system" },
        { id: "gpt-4o", object: "model", created: 1715367049, owned_by: "system" },
        { id: "gpt-4o-mini", object: "model", created: 1715367049, owned_by: "system" },
        { id: "gpt-5-6", object: "model", created: 1715367049, owned_by: "system" }
      ]
    }, null, 2));
    return;
  }
  
  // 对话补全（兼容 /chat/completions 和 /v1/chat/completions）
  if (req.method === "POST" && (url.pathname === "/v1/chat/completions" || url.pathname === "/chat/completions")) {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      try {
        const json = JSON.parse(body || "{}");
        const messages = json.messages || [];
        const userMsg = messages.slice().reverse().find(m => m.role === "user");
        const prompt = userMsg ? (typeof userMsg.content === 'string' ? userMsg.content : JSON.stringify(userMsg.content)) : "你好";
        const stream = !!json.stream;
        
        requestQueue.push({ prompt, stream, res });
        processQueue();
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: { message: "Invalid JSON body", type: "invalid_request_error" } }));
      }
    });
    return;
  }
  
  res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ error: { message: "Not Found", code: 404 } }));
});

server.listen(PORT, "127.0.0.1", async () => {
  log(`[EgoBridge] API 服务器已在 http://127.0.0.1:${PORT} 启动，正在初始化浏览器会话...`);
  await initBrowserSession();
});
