import fs from "node:fs";
import path from "node:path";
import { BaseProvider } from "./base.mjs";

export function messageContentToText(content) {
  if (typeof content === "string") return content;
  if (content == null) return "";
  if (Array.isArray(content)) {
    const parts = [];
    for (const item of content) {
      if (!item || typeof item !== "object") continue;
      if (item.type === "text" || item.type === "input_text") {
        parts.push(String(item.text || ""));
      } else if (["image_url", "input_image", "image"].includes(item.type)) {
        throw new Error("图片消息暂未支持直接传入；请先将图片转成文字描述，或等待图片桥接功能实现。");
      } else {
        throw new Error("暂不支持的消息内容类型：" + String(item.type || "unknown"));
      }
    }
    return parts.join("\n");
  }
  throw new Error("消息 content 必须是字符串或文本内容数组。");
}

export function buildPrompt(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error("messages 必须是非空数组。");
  }
  const supportedRoles = new Set(["system", "developer", "user", "assistant", "tool"]);
  const labels = {
    system: "系统指令",
    developer: "开发者指令",
    user: "用户",
    assistant: "助手历史回复",
    tool: "工具结果"
  };
  const normalized = messages.map((message, index) => {
    if (!message || typeof message !== "object" || !supportedRoles.has(message.role)) {
      throw new Error("messages[" + index + "].role 无效或暂不支持。");
    }
    return { role: message.role, content: messageContentToText(message.content) };
  });
  if (!normalized.some(message => message.role === "user")) {
    throw new Error("messages 至少需要包含一条 user 消息。");
  }
  if (normalized.length === 1 && normalized[0].role === "user") {
    return normalized[0].content;
  }
  const history = normalized.map(message => "【" + labels[message.role] + "】\n" + message.content).join("\n\n");
  return "请根据以下完整对话上下文回答最后一条用户消息。请将系统指令和开发者指令作为本次任务的要求，并保持上下文连贯。\n\n" + history;
}

export function extractAssistantReply(snapshot, userPrompt) {
  const editMarkers = ['button "编辑消息"', 'button "共享提示"', 'button "复制消息"'];
  let lastUserMsgEnd = -1;
  for (const marker of editMarkers) {
    const pos = snapshot.lastIndexOf(marker);
    if (pos > lastUserMsgEnd) lastUserMsgEnd = pos;
  }

  if (lastUserMsgEnd === -1 && userPrompt) {
    const pIdx = snapshot.lastIndexOf(`text "${userPrompt}"`);
    if (pIdx !== -1) lastUserMsgEnd = pIdx;
  }

  let relevantSnap = lastUserMsgEnd !== -1
    ? snapshot.slice(lastUserMsgEnd)
    : snapshot;

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
        'ChatGPT 说：', 'ChatGPT说：',
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

export function normalizeAssistantText(value, userPrompt = "") {
  let text = String(value || "").replace(/\r\n/g, "\n").replace(/\u00a0/g, " ").trim();
  if (!text || (userPrompt && text === String(userPrompt).trim())) return "";
  text = text.replace(/^(?:ChatGPT\s*说：|ChatGPT\s*说:)\s*/u, "");
  // Accessibility snapshots may flatten adjacent text nodes from separate
  // rendered lines. Restore the common numbered-line boundary without
  // changing ordinary prose paragraphs.
  text = text.replace(/([^\n])(第\d+行：)/gu, "$1\n$2");
  text = text.replace(/\n{3,}/g, "\n\n");
  const lines = text.split("\n");
  const ignored = new Set([
    "ChatGPT 说：", "ChatGPT说：", "复制消息", "共享提示", "编辑消息", "复制", "评价回复", "朗读", "分享",
    "重新生成回复", "重新生成回答", "更多操作", "来源", "查看来源",
    "已复制代码", "代码", "滚动到底部", "询问 ChatGPT", "正在思考", "思考过程"
  ]);
  while (lines.length > 0) {
    const last = lines[lines.length - 1].trim();
    if (!last) { lines.pop(); continue; }
    if (ignored.has(last) || /^思考强度\s*(?:Low|Medium|High|Extra High)$/i.test(last)) {
      lines.pop();
      continue;
    }
    break;
  }
  return lines.join("\n").trim();
}

export class ChatGPTProvider extends BaseProvider {
  constructor(options = {}) {
    super("chatgpt", "ChatGPT Bridge", options);
    this.rootDir = options.rootDir || process.cwd();
    this.globalTask = null;
    this.globalPage = null;
  }

  async init() {
    try {
      this.isReady = false;
      let spaceId = (process.env.EGO_TASK_SPACE_ID || "").trim();
      const spaceIdFile = path.join(this.rootDir, ".ego-task-space-id");
      if (!spaceId) {
        try { spaceId = fs.readFileSync(spaceIdFile, "utf8").trim(); } catch {}
      }
      if (!spaceId) {
        spaceId = "ChatGPT-Bridge-" + Date.now().toString(36);
        try { fs.writeFileSync(spaceIdFile, spaceId, "utf8"); } catch {}
      }
      this.log(`正在建立常驻任务空间: ${spaceId} ...`);

      const taskSpaceFn = typeof taskSpace !== "undefined" ? taskSpace : globalThis.taskSpace;
      if (!taskSpaceFn) {
        throw new Error("ego-browser taskSpace API 不可用，请确保通过 ego-browser nodejs 运行。");
      }

      try {
        this.globalTask = await taskSpaceFn(spaceId);
      } catch (spaceError) {
        if (!process.env.EGO_TASK_SPACE_ID && /Task space does not exist/i.test(spaceError.message || "")) {
          spaceId = "ChatGPT-Bridge-" + Date.now().toString(36);
          fs.writeFileSync(spaceIdFile, spaceId, "utf8");
          this.log("Saved task space is missing; created replacement: " + spaceId);
          this.globalTask = await taskSpaceFn(spaceId);
        } else {
          throw spaceError;
        }
      }

      const existingPages = await this.globalTask.pages();
      this.globalPage = existingPages.find(page => page.label === "p1") || existingPages[0] || await this.globalTask.newPage();

      this.log("导航至 https://chatgpt.com ...");
      await this.globalPage.goto("https://chatgpt.com", { timeout: 45000, waitUntil: "domcontentloaded" });

      this.log("等待 Sentinel 安全握手就绪 (6秒)...");
      await this.globalPage.waitForTimeout(6000);

      await this.globalPage.waitForSelector('div[role="textbox"]', { timeout: 15000 });

      this.isReady = true;
      this.initError = null;
      this.log("ChatGPT 常驻会话已完全就绪，开始接客！");
    } catch (err) {
      this.log(`会话初始化失败: ${err.message}`);
      this.initError = err.message;
      this.isReady = false;
    }
  }

  async ensureReady() {
    if (this.globalPage && this.isReady) {
      try {
        await this.globalPage.evaluate(() => 1);
        return;
      } catch (err) {
        this.log(`现有会话已失效，正在自动拉起新会话... (${err.message})`);
      }
    }
    await this.init();
    if (!this.isReady) {
      throw new Error("ChatGPT 会话无法就绪: " + (this.initError || "未知异常"));
    }
  }

  async installStreamObserver() {
    return this.globalPage.evaluate(() => {
      try {
        const state = {
          active: true,
          lastText: "",
          queue: [],
          error: null,
          observer: null
        };
        const clean = (value) => String(value || "")
          .replace(/^ChatGPT\s*说：\s*/u, "")
          .replace(/^ChatGPT\s*说:\s*/u, "")
          .trim();
        const readAssistantText = () => {
          const selectors = [
            '[data-message-author-role="assistant"]',
            '.markdown',
            '[data-message-content]',
            '[data-testid*="message-content"]'
          ];
          for (const selector of selectors) {
            const nodes = Array.from(document.querySelectorAll(selector));
            if (!nodes.length) continue;
            const node = nodes[nodes.length - 1];
            const text = clean(node.innerText || node.textContent || "");
            if (text) return text;
          }
          return "";
        };
        const capture = () => {
          if (!state.active) return;
          const text = readAssistantText();
          if (!text || text === state.lastText) return;
          if (state.lastText && !text.startsWith(state.lastText)) {
            state.error = "assistant text was rewritten instead of appended";
            state.active = false;
            return;
          }
          const delta = text.slice(state.lastText.length);
          state.lastText = text;
          if (delta) state.queue.push(delta);
        };
        state.observer = new MutationObserver(capture);
        state.observer.observe(document.body, { subtree: true, childList: true, characterData: true });
        capture();
        window.__egoBridgeStream = {
          drain() {
            const chunks = state.queue.splice(0);
            return { ok: !state.error, error: state.error, chunks, text: state.lastText };
          },
          stop() {
            state.active = false;
            try { state.observer?.disconnect(); } catch {}
            if (window.__egoBridgeStream) delete window.__egoBridgeStream;
          }
        };
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error?.message || String(error) };
      }
    });
  }

  async drainStreamObserver(onDelta) {
    const result = await this.globalPage.evaluate(() => {
      try {
        return window.__egoBridgeStream?.drain?.() || { ok: false, error: "stream observer unavailable", chunks: [] };
      } catch (error) {
        return { ok: false, error: error?.message || String(error), chunks: [] };
      }
    });
    if (!result?.ok) return result || { ok: false, error: "stream observer unavailable", chunks: [] };
    for (const chunk of result.chunks || []) {
      if (chunk) await onDelta(String(chunk));
    }
    return result;
  }

  async stopStreamObserver() {
    try {
      await this.globalPage.evaluate(() => window.__egoBridgeStream?.stop?.());
    } catch {}
  }

  async askChatGPT(prompt, options = {}) {
    await this.ensureReady();

    this.log("正在打开新的 ChatGPT 对话...");
    await this.globalPage.goto("https://chatgpt.com/", { timeout: 45000, waitUntil: "domcontentloaded" });
    await this.globalPage.waitForTimeout(800);
    await this.globalPage.waitForSelector('div[role="textbox"]', { timeout: 15000 });

    this.log(`开始处理提问: "${prompt.slice(0, 30)}..."`);

    // 步骤 A: 定位输入框并清空内容
    await this.globalPage.waitForSelector('div[role="textbox"]', { timeout: 15000 });
    await this.globalPage.click('div[role="textbox"]');
    await this.globalPage.waitForTimeout(300);
    await this.globalPage.keyboard.press("Control+A");
    await this.globalPage.keyboard.press("Backspace");
    await this.globalPage.waitForTimeout(300);

    // 步骤 B: 键入提示词
    await this.globalPage.keyboard.insertText(prompt);

    // 步骤 C: 等待发送按钮就绪
    for (let i = 0; i < 20; i++) {
      const isAvailable = await this.globalPage.evaluate(() => {
        const btn = document.querySelector('button[aria-label="发送"]');
        return btn && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true';
      });
      if (isAvailable) break;
      await this.globalPage.waitForTimeout(300);
    }

    // 在发送前安装增量监听器；如果当前页面没有可观察的 DOM，调用方会
    // 在生成结束后自动降级为一次性完整 JSON。
    let observerReady = false;
    if (typeof options.onDelta === "function") {
      const observer = await this.installStreamObserver();
      observerReady = Boolean(observer?.ok);
      if (!observerReady) this.log(`增量监听器安装失败，将降级为完整结果: ${observer?.error || "unknown"}`);
    }

    // 步骤 D: 点击发送
    await this.globalPage.click('button[aria-label="发送"]');
    this.log("已点击发送，等待模型响应生成...");

    // 步骤 E: 轮询等待生成完成
    const startTime = Date.now();
    let hasStarted = false;
    let hasAuthorizedTool = false;

    let lastObserverError = null;
    let lastMaintenanceAt = 0;
    while (Date.now() - startTime < 120000) {
      await this.globalPage.waitForTimeout(observerReady ? 200 : 1000);

      if (observerReady && typeof options.onDelta === "function") {
        const streamState = await this.drainStreamObserver(options.onDelta);
        if (!streamState?.ok) {
          lastObserverError = streamState?.error || "stream observer failed";
          observerReady = false;
          this.log(`增量监听器失效，将使用最终完整快照: ${lastObserverError}`);
        }
      }

      // Cloudflare 和授权按钮不需要每 200ms 检查一次。
      if (Date.now() - lastMaintenanceAt < 800) continue;
      lastMaintenanceAt = Date.now();

      // 1. 自动处理 Cloudflare Challenge
      const isCf = await this.globalPage.evaluate(() => {
        return document.body.innerText.includes('cloudflare_challenge');
      });
      if (isCf) {
        this.log("遇到 Cloudflare Challenge，尝试点击重试...");
        try {
          await this.globalPage.click('role:button[name="重试"], button:has-text("重试")');
          await this.globalPage.waitForTimeout(3000);
        } catch(e) {}
      }

      // 2. 自动检测并处理工具/Action 访问授权
      const authAction = await this.globalPage.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        const allowAlways = buttons.find(b => b.innerText && (b.innerText.includes('始终允许') || b.innerText.includes('Always allow')) && !b.disabled);
        if (allowAlways) {
          const text = allowAlways.innerText.trim();
          allowAlways.click();
          return { clicked: text, type: "always" };
        }
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
        this.log(`[权限拦截] 侦测到 ChatGPT 访问授权请求，已默认自动同意并点击: "${authAction.clicked}"`);
        await this.globalPage.waitForTimeout(1500);
      }

      const status = await this.globalPage.evaluate(() => {
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

      if (hasStarted && !status.generating && status.regen) {
        this.log("模型回答生成完毕！");
        break;
      }
    }

    if (observerReady && typeof options.onDelta === "function") {
      const streamState = await this.drainStreamObserver(options.onDelta);
      if (!streamState?.ok) lastObserverError = streamState?.error || "stream observer failed";
    }
    await this.stopStreamObserver();
    await this.globalPage.waitForTimeout(1200);

    // 步骤 F: 优先从最后一条 assistant 消息 DOM 提取正文
    // 默认 snapshot 只覆盖当前视口；长回复会被截断在首屏。完整快照才能
    // 覆盖滚动区域中的全部 assistant 内容。
    const snap = await this.globalPage.snapshot({ scope: "full_page" });
    const snapshotReply = normalizeAssistantText(extractAssistantReply(snap, prompt), prompt);
    let domDiagnostics = { assistantCount: 0, source: "none", chars: 0, text: "" };
    try {
      domDiagnostics = await this.globalPage.evaluate(() => {
        const messages = Array.from(document.querySelectorAll('[data-message-author-role="assistant"]'));
        const last = messages[messages.length - 1];
        if (!last) return { assistantCount: messages.length, source: "none", chars: 0, text: "" };

        const selectors = [".markdown", "[data-message-content]", '[data-testid*="message-content"]'];
        for (const selector of selectors) {
          const nodes = Array.from(last.querySelectorAll(selector));
          const text = nodes.map(node => (node.innerText || node.textContent || "").trim()).filter(Boolean).join("\n\n").trim();
          if (text) return {
            assistantCount: messages.length,
            source: selector,
            chars: text.length,
            text,
            messageId: last.getAttribute("data-message-id") || ""
          };
        }
        const text = (last.innerText || last.textContent || "").trim();
        return {
          assistantCount: messages.length,
          source: "assistant-node",
          chars: text.length,
          text,
          messageId: last.getAttribute("data-message-id") || ""
        };
      });
    } catch (error) {
      this.log(`DOM 回答提取失败，使用无障碍快照后备: ${error.message}`);
    }

    if (!domDiagnostics || typeof domDiagnostics !== "object") {
      domDiagnostics = { assistantCount: 0, source: "none", chars: 0, text: "" };
    }
    const domReply = normalizeAssistantText(domDiagnostics.text, prompt);
    let replyText = "";
    let extractionSource = "none";
    if (domReply && (!snapshotReply || domReply.length >= snapshotReply.length || snapshotReply.length < 80)) {
      replyText = domReply;
      extractionSource = "assistant_dom:" + domDiagnostics.source;
    } else if (snapshotReply) {
      replyText = snapshotReply;
      extractionSource = "accessibility_snapshot";
    } else if (domReply) {
      replyText = domReply;
      extractionSource = "assistant_dom:" + domDiagnostics.source;
    }

    const hadReasoningControlArtifact = /思考强度\s*(?:Low|Medium|High|Extra High)/i.test(snap);
    if (hadReasoningControlArtifact && replyText.length < 80) {
      this.log(`回答提取疑似混入界面控件：snapshotChars=${snap.length}, domChars=${domDiagnostics.chars}, snapshotReplyChars=${snapshotReply.length}, domReplyChars=${domReply.length}`);
      if (domReply.length <= replyText.length) {
        throw new Error("回答提取疑似截断（检测到思考强度界面控件且正文过短）；已阻止发送不完整回复。");
      }
    }

    this.log(`回答提取完成: source=${extractionSource}, assistantNodes=${domDiagnostics.assistantCount}, domChars=${domDiagnostics.chars}, snapshotChars=${snap.length}, snapshotReplyChars=${snapshotReply.length}, replyChars=${replyText.length}`);
    if (!replyText) this.log("回答提取结果为空。");
    if (lastObserverError) this.log(`增量监听最终状态: ${lastObserverError}`);
    return replyText || "（未能提取到回复，请重试）";
  }

  getModels() {
    return [
      { id: "chatgpt-plus", object: "model", created: 1715367049, owned_by: "system" },
      { id: "gpt-4o", object: "model", created: 1715367049, owned_by: "system" },
      { id: "gpt-4o-mini", object: "model", created: 1715367049, owned_by: "system" },
      { id: "gpt-5-6", object: "model", created: 1715367049, owned_by: "system" }
    ];
  }

  async close() {
    try {
      if (this.globalPage && typeof this.globalPage.close === "function") {
        await this.globalPage.close();
      }
    } catch (err) {
      this.log("页面关闭提示: " + err.message);
    }
  }
}
