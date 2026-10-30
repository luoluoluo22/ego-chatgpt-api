# Ego Web API Bridge (ChatGPT & Suno AI)

> 基于 **ego-browser**（Citro Labs Chromium 浏览器引擎）打造的高性能、免风控、多 Provider 架构的 **网页端 AI 转标准 API 本地桥接服务**。
> 目前已原生支持 **ChatGPT (OpenAI 兼容对话)** 与 **Suno AI (官方网页端转音乐生成 API)**，并提供完全解耦的 Provider 扩展能力。

对外提供 100% 兼容 OpenAI 官方规范的 HTTP 接口与 Suno 生态接口，可直接接入 **燕子 (Yanzi)**、**Cherry Studio**、**NextChat (ChatGPT-Next-Web)**、**ChatBox**、**LobeChat**、Suno 客户端以及各类标准 Agent / SDK。

---

## 🌟 为什么选择原生浏览器桥接？

| 对比维度 | 纯 HTTP 逆向派 (aurora / suno-api 等) | 本项目 (ego-browser 真实会话桥接) |
| :--- | :--- | :--- |
| **反爬对抗** | 频繁遭遇 Cloudflare Turnstile 盾、TLS 403 证书指纹阻断 | **零封控风险**：使用原生 Chromium 硬件环境与真实 TLS 握手 |
| **Sentinel / Clerk 认证**| 需逆向 PoW 工作量证明与 Clerk 动态 JWT 握手，官方一改即失效 | **自动通过**：网页底层 Sentinel 与 Clerk 原生握手完成 |
| **登录与凭证** | 需提取 AccessToken / SessionToken / Cookie，极易过期与掉线 | **持久免维护**：直接复用浏览器已登录的 Cookie 与账号会话 |
| **外部工具与权限** | 无法支持网页端交互授权，调用本地工具/Action 会卡死 | **自动授权 (Auto-Consent)**：自动点击“始终允许”，支持各类工具调用 |
| **扩展性** | 每接入一个网站都需要全套逆向工程 | **模块化 Provider**：利用统一的浏览器会话与页面执行能力快速扩展 |

---

## 🧩 模块化 Provider 架构

项目采用插件化 Provider 体系（位于 `providers/` 目录）：
```
providers/
├── base.mjs       # BaseProvider 抽象基类，规范生命周期 (init, ensureReady, getModels, getHealth)
├── chatgpt.mjs    # ChatGPT Provider（网页问答、对话提取、SSE 打字机推送、权限拦截）
└── suno.mjs       # Suno Provider（支持 https://suno.com/create?wid=default 音乐创作）
```

可自由通过 `.env` 中的 `EGO_PROVIDERS` 配置启用的服务：
```env
# 仅启用 ChatGPT
EGO_PROVIDERS=chatgpt

# 仅启用 Suno
EGO_PROVIDERS=suno

# 同时启用两者（默认）
EGO_PROVIDERS=chatgpt,suno
```

---

## 🚀 快速启动与停止

### 前置要求
- 已安装 **ego-browser** (Citro Labs)。
- 在 ego-browser 窗口中已登录 ChatGPT 和/或 Suno (`https://suno.com`)。
- Windows 环境（PowerShell 5.1+）。

### 启动服务
- **方式一（推荐）**：双击工程根目录下的 `start.bat`。
- **方式二（PowerShell）**：
  ```powershell
  powershell -ExecutionPolicy Bypass -File .\start-server.ps1
  ```

### 停止服务
- **双击批处理**：直接运行 `stop.bat`。
- **PowerShell**：
  ```powershell
  powershell -ExecutionPolicy Bypass -File .\stop-server.ps1
  ```

### 🖥️ 可视化管理面板 (Web Dashboard)
服务启动后会自动在系统默认浏览器中打开状态管理面板：
- **访问地址**：`http://127.0.0.1:8765/` 或 `http://127.0.0.1:8765/dashboard`
- **快捷打开方式**：双击运行根目录下的 **`open-dashboard.bat`** 或运行 `npm run dashboard`。
- **核心面板功能**：
  - **服务与各 Provider 实时健康监控**：实时查看网关、ChatGPT 网页原生会话、Suno 音乐创作会话的状态与队列排队数。
  - **在线 API 交互测试台 (Playground)**：可视化调试问答接口，支持普通模式与 Stream SSE 流式打字机输出，实时显示响应文本与计时器。
  - **实时运行日志控制台 (Live Logs)**：支持每 3 秒自动轮询拉取 `/logs`，无需切回终端即可查看后台活动。
  - **多语言与客户端集成指引**：内置 cURL、Python、Node.js 及 NextChat / ChatBox 的一键复制示例。

### 开机自启动 (Windows 计划任务)
服务将注册为当前用户登录后静默自启动（延时 10 秒等待网络与底层浏览器就绪，后台无黑框）：
- **启用开机自启**：双击运行 **`enable-autostart.bat`** 或 `npm run autostart:enable`。
- **取消开机自启**：双击运行 **`disable-autostart.bat`** 或 `npm run autostart:disable`。

---

## 📡 API 端点列表

服务默认监听：`http://127.0.0.1:8765`

### 1. 通用端点

#### 健康检查
- **端点**：`GET /health` 或 `GET /`
- **响应**：
```json
{
  "status": "ready",
  "providers": {
    "chatgpt": { "name": "chatgpt", "displayName": "ChatGPT Bridge", "ready": true, "error": null },
    "suno": { "name": "suno", "displayName": "Suno Music Bridge", "ready": true, "error": null }
  },
  "initError": null,
  "message": "Ego Web API Bridge is online and ready",
  "port": 8765,
  "authEnabled": false
}
```

#### 模型聚合列表
- **端点**：`GET /v1/models` 或 `GET /models`
- **支持模型**：
  - ChatGPT: `chatgpt-plus`, `gpt-4o`, `gpt-4o-mini`, `gpt-5-6`
  - Suno: `suno-v4`, `suno-v3.5`, `suno-v3`, `chirp-v4`, `chirp-v3-5`

---

### 2. Suno AI 音乐创作端点 (`https://suno.com/create?wid=default`)

提供浏览器会话直接代理的 Suno 音乐创作接口，支持简易模式、自定义歌词模式、状态查询与 OpenAI 兼容格式。

#### 2.1 简易模式生成 (Simple Mode)
- **端点**：`POST /v1/suno/generate`（或兼容别名 `POST /api/generate`）
- **请求体**：
```json
{
  "prompt": "一段充满力量感、80年代复古合成器风格的电子音乐，适合夜间飞车",
  "make_instrumental": false,
  "model": "chirp-v3-5",
  "wait_audio": false
}
```
> 参数说明：
> - `prompt`: 歌曲主题/流派描述。
> - `make_instrumental`: 是否为纯纯音乐（布尔值，默认 `false`）。
> - `model`: 模型版本，支持 `chirp-v3-5` (v3.5) 或 `chirp-v4` (v4)。
> - `wait_audio`: 是否阻塞等待直到音频渲染完成并输出 playable URL（布尔值，默认 `false`）。

- **响应**：
```json
{
  "code": 200,
  "message": "success",
  "data": [
    {
      "id": "clip-uuid-1",
      "title": "Night Driver",
      "audio_url": "https://audiopipe.suno.ai/...",
      "image_url": "https://cdn1.suno.ai/...",
      "status": "submitted",
      "duration": 0
    },
    {
      "id": "clip-uuid-2",
      "title": "Night Driver Part 2",
      "audio_url": "https://audiopipe.suno.ai/...",
      "image_url": "https://cdn1.suno.ai/...",
      "status": "submitted",
      "duration": 0
    }
  ]
}
```

#### 2.2 自定义模式生成 (Custom Mode)
- **端点**：`POST /v1/suno/custom_generate`（或兼容别名 `POST /api/custom_generate`）
- **请求体**：
```json
{
  "prompt": "[Verse 1]\n霓虹闪烁的街头\n雨水滴落在车窗\n[Chorus]\n奔向没有尽头的黑夜",
  "tags": "synthwave, electronic, energetic, 120bpm",
  "title": "霓虹之夜",
  "make_instrumental": false,
  "model": "v4",
  "wait_audio": true
}
```
> 参数说明：
> - `prompt`: 歌词内容（支持包含 Verse/Chorus 结构标记）。
> - `tags`: 风格标签与乐器属性。
> - `title`: 自定义歌曲标题。

#### 2.3 查询歌曲片段状态 (Feed)
- **端点**：`GET /v1/suno/feed?ids=clip-uuid-1,clip-uuid-2`（或 `GET /api/feed`）
- **响应**：返回当前歌曲的渲染进度状态、时长、最终 mp3 音频地址与高清封面。

#### 2.4 查询账户剩余额度 (Credits & Limit)
- **端点**：`GET /v1/suno/credits`（或 `GET /v1/suno/limit`、`GET /api/get_limit`）
- **响应**：
```json
{
  "code": 200,
  "message": "success",
  "data": {
    "total_credits_left": 450,
    "period": "monthly",
    "monthly_limit": 2500,
    "monthly_usage": 2050
  }
}
```

#### 2.5 OpenAI 音频生成标准格式 (POST /v1/audio/generations)
针对 OpenAI 客户端与通用 Agent 设计的音频生成接口：
- **端点**：`POST /v1/audio/generations`
- **请求体**：
```json
{
  "prompt": "Chill lofi hip-hop beat for studying and relax",
  "model": "suno-v3.5"
}
```
- **响应**：
```json
{
  "created": 1715367049,
  "data": [
    {
      "id": "clip-uuid-1",
      "url": "https://d2lwuy8qc234o3.cloudfront.net/1/clip/clip-uuid-1.m4a",
      "image_url": "https://cdn2.suno.ai/image_clip-uuid-1.jpeg",
      "title": "Chill Study Beat",
      "status": "complete",
      "duration": 145.2
    }
  ]
}
```

#### 2.6 音频文件直接下载与本地代理 (Download Audio)
- **端点**：`GET /v1/suno/download/:id` 或 `GET /v1/suno/download?id=:id`
- **说明**：自动从本地 `./downloads/` 读取或向 Suno CloudFront 代理下载 `.m4a` 原始音频流，并携带 `Content-Disposition: attachment` 供浏览器和外部脚本直接另存为文件。
- **示例**：`http://localhost:8765/v1/suno/download/281a067d-82e5-4ff2-86e8-88504a9a748b`
- **本地自动落盘**：在调用 `/v1/suno/generate` 或 `/v1/suno/custom_generate` 时传入 `"download_local": true`，服务将在生成完毕后自动下载并保存到本地 `./downloads/` 目录并返回 `local_path`。

---

### 3. ChatGPT 对话补全端点 (OpenAI 兼容)

#### 对话补全 (Chat Completions)
- **端点**：`POST /v1/chat/completions` 或 `POST /chat/completions`
- **请求体（非流式）**：
```json
{
  "model": "chatgpt-plus",
  "messages": [
    { "role": "user", "content": "你好，请用一句话介绍你自己" }
  ],
  "stream": false
}
```
- **请求体（流式 SSE）**：
```json
{
  "model": "chatgpt-plus",
  "messages": [
    { "role": "user", "content": "写一段 Python 代码演示冒泡排序" }
  ],
  "stream": true
}
```

---

## 🛠️ 如何继续扩展新的网页 API？

得益于模块化架构，扩展任何新的网页 API（例如 Kimi、Midjourney、Claude、Kling 等）仅需两步：

1. **新建 Provider**（如 `providers/my_service.mjs`）：
   继承 `BaseProvider`，实现关键生命周期：
   ```javascript
   import { BaseProvider } from "./base.mjs";

   export class MyServiceProvider extends BaseProvider {
     constructor(options = {}) {
       super("myservice", "My Service Bridge", options);
     }

     async init() {
       const taskSpaceFn = typeof taskSpace !== "undefined" ? taskSpace : globalThis.taskSpace;
       this.task = await taskSpaceFn("MyService-Space");
       this.page = (await this.task.pages())[0] || await this.task.newPage();
       await this.page.goto("https://my-service.com/dashboard");
       this.isReady = true;
     }

     async ensureReady() {
       if (this.page && this.isReady) return;
       await this.init();
     }

     getModels() {
       return [{ id: "my-model-v1", object: "model", created: 1715367049, owned_by: "myservice" }];
     }

     // 业务方法：利用 page.evaluate() 或 page.click() 执行网页操作或发起带凭据的 fetch
     async generateContent(prompt) { ... }
   }
   ```

2. **在 `server.mjs` 中注册路由**：
   在 `providers` 列表中注册实例并在路由处映射对应的 HTTP 路由即可。

---

## 🧪 自动化测试验证

本项目拥有完备的自动化测试体系：

```powershell
# 1. 快速单元与安全校验（免浏览器登录）
npm run test:unit

# 2. ChatGPT 模拟集成端到端测试
npm run test:mock

# 3. Suno 音乐创作模拟集成测试
npm run test:suno

# 4. 真实浏览器环境联调测试（需本机已登录各网站）
npm test
```

---

## 📄 开源许可证

本项目基于 [MIT License](LICENSE) 开源。
