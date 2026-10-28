import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { ChatGPTProvider, buildPrompt, messageContentToText } from "./providers/chatgpt.mjs";
import { SunoProvider } from "./providers/suno.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_FILE = path.resolve(process.env.EGO_API_LOG_FILE || path.join(__dirname, "server.log"));
const PORT = Number.parseInt(process.env.EGO_API_PORT || "8765", 10);
const MAX_BODY_BYTES = Math.max(1024, Number.parseInt(process.env.EGO_MAX_BODY_BYTES || "2097152", 10));
const MAX_QUEUE_LENGTH = Math.max(1, Number.parseInt(process.env.EGO_MAX_QUEUE_LENGTH || "32", 10));
const API_KEY = (process.env.EGO_API_KEY || "").trim();
const LOCAL_ORIGIN = /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i;

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_FILE, line + "\n", "utf8");
  } catch (e) {}
}

function hasValidApiKey(req) {
  const auth = String(req.headers.authorization || "");
  const bearer = auth.match(/^Bearer\s+(.+)$/i)?.[1] || "";
  let queryKey = "";
  try {
    queryKey = new URL(req.url, "http://localhost").searchParams.get("api_key") || "";
  } catch (e) {}
  const supplied = String(req.headers["x-api-key"] || bearer || queryKey);
  if (!API_KEY || !supplied) return false;
  const expectedBuffer = Buffer.from(API_KEY, "utf8");
  const suppliedBuffer = Buffer.from(supplied, "utf8");
  return expectedBuffer.length === suppliedBuffer.length && timingSafeEqual(expectedBuffer, suppliedBuffer);
}

function sendJson(res, statusCode, payload) {
  if (res.headersSent || res.destroyed) {
    if (!res.destroyed) res.end();
    return;
  }
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(payload, null, 2));
}

// 实例化 Provider 组件
const enabledProviderNames = (process.env.EGO_PROVIDERS || "chatgpt,suno")
  .split(",")
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

const providers = {};
if (enabledProviderNames.includes("chatgpt")) {
  providers.chatgpt = new ChatGPTProvider({ rootDir: __dirname, log });
}
if (enabledProviderNames.includes("suno")) {
  providers.suno = new SunoProvider({ rootDir: __dirname, log });
}

const chatgptProvider = providers.chatgpt || null;
const sunoProvider = providers.suno || null;

// ChatGPT 问答请求队列
const chatRequestQueue = [];
let isChatProcessing = false;

async function processChatQueue() {
  if (isChatProcessing || chatRequestQueue.length === 0) return;
  isChatProcessing = true;
  const { prompt, stream, res } = chatRequestQueue.shift();

  try {
    if (!chatgptProvider) {
      throw new Error("ChatGPT Provider 未启用。");
    }
    const reply = await chatgptProvider.askChatGPT(prompt);
    const created = Math.floor(Date.now() / 1000);
    const id = "chatcmpl-" + Math.random().toString(36).substring(2, 12);

    if (stream) {
      // 标准 OpenAI SSE 流式输出
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive"
      });

      const chunkSize = 4;
      const replyChars = Array.from(reply);
      for (let i = 0; i < replyChars.length; i += chunkSize) {
        const deltaContent = replyChars.slice(i, i + chunkSize).join("");
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
    log(`[EgoBridge] ChatGPT 处理异常: ${err.message}`);
    sendJson(res, 500, { error: { message: err.message, type: "server_error" } });
  } finally {
    isChatProcessing = false;
    processChatQueue();
  }
}

// 统一请求体解析工具
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    let bodyBytes = 0;
    let oversized = false;
    req.on("data", chunk => {
      bodyBytes += chunk.length;
      if (bodyBytes > MAX_BODY_BYTES) {
        oversized = true;
        body = "";
        return;
      }
      if (!oversized) body += chunk.toString("utf8");
    });
    req.on("end", () => {
      if (oversized) {
        const err = new Error("Request body exceeds " + MAX_BODY_BYTES + " bytes.");
        err.statusCode = 413;
        err.type = "request_too_large";
        return reject(err);
      }
      try {
        const json = JSON.parse(body || "{}");
        if (!json || typeof json !== "object" || Array.isArray(json)) {
          const err = new Error("Request body must be a JSON object.");
          err.statusCode = 400;
          err.type = "invalid_request_error";
          return reject(err);
        }
        resolve(json);
      } catch (e) {
        const err = new Error(e.message || "Invalid JSON body.");
        err.statusCode = 400;
        err.type = "invalid_request_error";
        reject(err);
      }
    });
    req.on("error", err => {
      err.statusCode = 400;
      err.type = "invalid_request_error";
      reject(err);
    });
  });
}

// HTTP 服务器定义
const server = http.createServer(async (req, res) => {
  const origin = String(req.headers.origin || "");
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-API-Key");

  if (origin && !LOCAL_ORIGIN.test(origin)) {
    sendJson(res, 403, { error: { message: "Only localhost origins are allowed.", type: "forbidden" } });
    return;
  }
  if (origin) res.setHeader("Access-Control-Allow-Origin", origin);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // 安全拦截：受保护的端点需要 API Key（若配置了 API_KEY）
  const isProtected = url.pathname === "/logs" ||
    url.pathname === "/shutdown" ||
    url.pathname === "/chat/completions" ||
    url.pathname === "/v1/chat/completions" ||
    url.pathname.startsWith("/v1/suno/") ||
    url.pathname.startsWith("/api/") ||
    url.pathname === "/v1/audio/generations";

  if (API_KEY && isProtected && !hasValidApiKey(req)) {
    sendJson(res, 401, { error: { message: "Missing or invalid API key.", type: "authentication_error" } });
    return;
  }

  // 1. 服务优雅关闭
  if (req.method === "POST" && url.pathname === "/shutdown") {
    sendJson(res, 202, { status: "stopping", message: "The local API listener is shutting down." });
    setTimeout(async () => {
      for (const p of Object.values(providers)) {
        try { await p.close(); } catch (e) {}
      }
      server.close(() => log("[EgoBridge] API listener stopped via /shutdown."));
    }, 100);
    return;
  }

  // 2. 健康检查
  if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/")) {
    const providerHealth = {};
    let allReady = true;
    let anyError = null;

    for (const [key, p] of Object.entries(providers)) {
      const h = p.getHealth();
      providerHealth[key] = h;
      if (!h.ready) allReady = false;
      if (h.error && !anyError) anyError = h.error;
    }

    const overallStatus = allReady ? "ready" : (anyError ? "error" : "initializing");
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({
      status: overallStatus,
      providers: providerHealth,
      initError: anyError,
      message: "Ego Web API Bridge is online and ready",
      port: PORT,
      authEnabled: Boolean(API_KEY),
      queueLength: chatRequestQueue.length,
      maxQueueLength: MAX_QUEUE_LENGTH
    }, null, 2));
    return;
  }

  // 3. 实时日志查询
  if (req.method === "GET" && url.pathname === "/logs") {
    let logs = "";
    try {
      logs = fs.existsSync(LOG_FILE) ? fs.readFileSync(LOG_FILE, "utf8") : "暂无日志";
    } catch (e) { logs = e.message; }
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(logs);
    return;
  }

  // 4. 模型列表聚合
  if (req.method === "GET" && (url.pathname === "/v1/models" || url.pathname === "/models")) {
    const allModels = [];
    for (const p of Object.values(providers)) {
      allModels.push(...p.getModels());
    }
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({
      object: "list",
      data: allModels
    }, null, 2));
    return;
  }

  // 5. ChatGPT 对话补全
  if (req.method === "POST" && (url.pathname === "/v1/chat/completions" || url.pathname === "/chat/completions")) {
    try {
      const json = await readJsonBody(req);
      const prompt = buildPrompt(json.messages);
      if (chatRequestQueue.length >= MAX_QUEUE_LENGTH) {
        sendJson(res, 429, { error: { message: "Request queue is full; retry shortly.", type: "rate_limit_error" } });
        return;
      }
      const stream = json.stream === true;
      chatRequestQueue.push({ prompt, stream, res });
      processChatQueue();
    } catch (err) {
      sendJson(res, err.statusCode || 400, { error: { message: err.message || "Invalid request.", type: err.type || "invalid_request_error" } });
    }
    return;
  }

  // 6. Suno 音乐创作接口
  // 6.1 简易描述生成
  if (req.method === "POST" && (url.pathname === "/v1/suno/generate" || url.pathname === "/api/generate")) {
    if (!sunoProvider) {
      sendJson(res, 503, { error: { message: "Suno Provider 未启用，请在 EGO_PROVIDERS 中包含 suno。", type: "provider_unavailable" } });
      return;
    }
    try {
      const json = await readJsonBody(req);
      const clips = await sunoProvider.generateSong({
        prompt: json.prompt || json.description || "",
        make_instrumental: Boolean(json.make_instrumental),
        model: json.model || json.mv || "chirp-v3-5",
        wait_audio: Boolean(json.wait_audio),
        download_local: Boolean(json.download_local),
        timeout_ms: json.timeout_ms || 120000
      });
      sendJson(res, 200, { code: 200, message: "success", data: clips });
    } catch (err) {
      sendJson(res, err.statusCode || 500, { error: { message: err.message || "Suno generate failed.", type: "suno_error" } });
    }
    return;
  }

  // 6.2 自定义创作模式（歌词、风格标签、歌曲标题）
  if (req.method === "POST" && (url.pathname === "/v1/suno/custom_generate" || url.pathname === "/api/custom_generate")) {
    if (!sunoProvider) {
      sendJson(res, 503, { error: { message: "Suno Provider 未启用，请在 EGO_PROVIDERS 中包含 suno。", type: "provider_unavailable" } });
      return;
    }
    try {
      const json = await readJsonBody(req);
      const clips = await sunoProvider.generateSong({
        prompt: json.prompt || "",
        tags: json.tags || json.style || "",
        title: json.title || "",
        make_instrumental: Boolean(json.make_instrumental),
        model: json.model || json.mv || "chirp-v3-5",
        wait_audio: Boolean(json.wait_audio),
        download_local: Boolean(json.download_local),
        timeout_ms: json.timeout_ms || 120000,
        is_custom: true
      });
      sendJson(res, 200, { code: 200, message: "success", data: clips });
    } catch (err) {
      sendJson(res, err.statusCode || 500, { error: { message: err.message || "Suno custom_generate failed.", type: "suno_error" } });
    }
    return;
  }

  // 6.3 音频文件下载与流式直链代理 (GET /v1/suno/download/:id 或 ?id=...)
  if (req.method === "GET" && (url.pathname.startsWith("/v1/suno/download") || url.pathname.startsWith("/api/download"))) {
    let clipId = url.searchParams.get("id") || "";
    if (!clipId) {
      const parts = url.pathname.split("/").filter(Boolean);
      clipId = parts[parts.length - 1];
      if (clipId === "download") clipId = "";
    }

    if (!clipId) {
      sendJson(res, 400, { error: { message: "Missing clip id for download.", type: "invalid_request_error" } });
      return;
    }

    try {
      const downloadsDir = path.join(__dirname, "downloads");
      let matchedFile = null;
      if (fs.existsSync(downloadsDir)) {
        const files = fs.readdirSync(downloadsDir);
        matchedFile = files.find(f => f.includes(clipId.slice(0, 8)));
      }

      if (matchedFile) {
        const filePath = path.join(downloadsDir, matchedFile);
        const stat = fs.statSync(filePath);
        res.writeHead(200, {
          "Content-Type": "audio/mp4",
          "Content-Length": stat.size,
          "Content-Disposition": `attachment; filename="${encodeURIComponent(matchedFile)}"`,
          "Cache-Control": "public, max-age=86400"
        });
        fs.createReadStream(filePath).pipe(res);
        return;
      }

      // 从 CloudFront 直链获取并缓存
      const cdnUrl = `https://d2lwuy8qc234o3.cloudfront.net/1/clip/${clipId}.m4a`;
      const cdnRes = await fetch(cdnUrl);
      if (!cdnRes.ok) {
        sendJson(res, cdnRes.status, { error: { message: `Audio file not found on Suno CDN (status ${cdnRes.status})`, type: "not_found" } });
        return;
      }

      const filename = `suno-${clipId.slice(0, 8)}.m4a`;
      const filePath = path.join(downloadsDir, filename);
      if (!fs.existsSync(downloadsDir)) fs.mkdirSync(downloadsDir, { recursive: true });

      const arrayBuffer = await cdnRes.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      try { fs.writeFileSync(filePath, buffer); } catch (e) {}

      res.writeHead(200, {
        "Content-Type": "audio/mp4",
        "Content-Length": buffer.length,
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "public, max-age=86400"
      });
      res.end(buffer);
      return;
    } catch (err) {
      log(`[EgoBridge] 音频下载异常 (${clipId}): ${err.message}`);
      sendJson(res, 500, { error: { message: err.message, type: "download_error" } });
      return;
    }
  }

  // 6.3 状态与 Feed 轮询查询
  if (req.method === "GET" && (url.pathname === "/v1/suno/feed" || url.pathname === "/api/feed")) {
    if (!sunoProvider) {
      sendJson(res, 503, { error: { message: "Suno Provider 未启用", type: "provider_unavailable" } });
      return;
    }
    try {
      const idsParam = url.searchParams.get("ids") || "";
      const ids = idsParam ? idsParam.split(",") : [];
      const clips = await sunoProvider.getFeed(ids);
      sendJson(res, 200, { code: 200, message: "success", data: clips });
    } catch (err) {
      sendJson(res, 500, { error: { message: err.message, type: "suno_error" } });
    }
    return;
  }

  // 6.4 账户额度查询
  if (req.method === "GET" && (url.pathname === "/v1/suno/credits" || url.pathname === "/v1/suno/limit" || url.pathname === "/api/get_limit")) {
    if (!sunoProvider) {
      sendJson(res, 503, { error: { message: "Suno Provider 未启用", type: "provider_unavailable" } });
      return;
    }
    try {
      const credits = await sunoProvider.getCredits();
      sendJson(res, 200, { code: 200, message: "success", data: credits });
    } catch (err) {
      sendJson(res, 500, { error: { message: err.message, type: "suno_error" } });
    }
    return;
  }

  // 6.5 OpenAI 音频生成兼容端点 (POST /v1/audio/generations)
  if (req.method === "POST" && (url.pathname === "/v1/audio/generations" || url.pathname === "/audio/generations")) {
    if (!sunoProvider) {
      sendJson(res, 503, { error: { message: "Suno Provider 未启用", type: "provider_unavailable" } });
      return;
    }
    try {
      const json = await readJsonBody(req);
      const clips = await sunoProvider.generateSong({
        prompt: json.prompt || "",
        tags: json.tags || "",
        title: json.title || "",
        make_instrumental: Boolean(json.make_instrumental),
        model: json.model || "chirp-v3-5",
        wait_audio: json.wait_audio !== false, // 默认等待完成以输出可以直接播放的 url
        timeout_ms: json.timeout_ms || 120000
      });
      const data = clips.map(c => ({
        id: c.id,
        url: c.audio_url || "",
        image_url: c.image_url || "",
        title: c.title || "",
        status: c.status || "",
        duration: c.duration || 0
      }));
      sendJson(res, 200, {
        created: Math.floor(Date.now() / 1000),
        data
      });
    } catch (err) {
      sendJson(res, err.statusCode || 500, { error: { message: err.message, type: "audio_generation_error" } });
    }
    return;
  }

  // 404
  res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ error: { message: "Not Found", code: 404 } }));
});

// 服务启动逻辑
if (process.env.EGO_API_TEST_MODE !== "1") {
  server.listen(PORT, "127.0.0.1", async () => {
    log("[EgoBridge] API 服务器已在 http://127.0.0.1:" + PORT + " 启动，正在初始化启用的服务提供者...");
    if (!API_KEY) log("[Security] EGO_API_KEY 未设置：当前仍允许本机客户端无令牌访问；请在需要多用户或隧道访问时配置 API Key。");

    for (const [name, p] of Object.entries(providers)) {
      log(`[EgoBridge] 正在初始化 Provider: ${name} ...`);
      p.init().catch(err => {
        log(`[EgoBridge] Provider ${name} 异步初始化异常: ${err.message}`);
      });
    }
  });
}

export {
  server,
  providers,
  chatgptProvider,
  sunoProvider,
  buildPrompt,
  messageContentToText
};
