# Ego ChatGPT API Bridge

> 基于 **ego-browser**（Citro Labs Chromium 浏览器引擎）打造的高性能、免风控、支持工具自动授权的 **ChatGPT 官方 Web 转 OpenAI 兼容 API 本地桥接服务**。

对外提供 100% 兼容 OpenAI 官方规范的 HTTP 接口，可直接接入 **燕子 (Yanzi)**、**Cherry Studio**、**NextChat (ChatGPT-Next-Web)**、**ChatBox**、**LobeChat** 以及各类标准 OpenAI SDK。

---

## 🌟 为什么选择原生浏览器桥接？

| 对比维度 | 纯 HTTP 逆向派 (aurora / go-chatgpt-api 等) | 本项目 (ego-browser 真实会话桥接) |
| :--- | :--- | :--- |
| **反爬对抗** | 频繁遭遇 Cloudflare Turnstile 盾、TLS 403 证书指纹阻断 | **零封控风险**：使用原生 Chromium 硬件环境与真实 TLS 握手 |
| **Sentinel 认证** | 需逆向 PoW 工作量证明与 dx 动态加密参数，官方一改即失效 | **自动通过**：网页底层 Sentinel 算法脚本原生握手完成 |
| **登录与凭证** | 需提取 AccessToken / SessionToken，极易过期与掉线 | **持久免维护**：直接复用浏览器已登录的 Cookie 与账号会话 |
| **外部工具授权** | 无法支持网页端交互授权，调用本地工具/Action 会卡死 | **自动授权 (Auto-Consent)**：自动点击“始终允许”，支持 Raccoon/Action 工具调用 |
| **回答完整性** | 易被流式切片或富文本截断 | **结构化语义提取**：递归提取完整无障碍树，支持段落、代码块、列表 |

---

## 🚀 快速启动与停止

### 前置要求
- 已安装 **ego-browser** (Citro Labs) 并处于已登录 ChatGPT 状态。
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

---

## 🔄 双电脑代码双向同步 (Git Sync)

本项目内置 Git 双向同步套件，方便在主开发电脑与此电脑之间保持最新代码同步。

### 1. 临时要求马上推送 / 立即同步 (On-Demand)
当你修改了代码希望主电脑立刻收到，或者想立刻拉取主电脑推送的代码：
- **方式一**：双击运行 **`sync-now.bat`**。
- **方式二**：命令行运行：
  ```powershell
  npm run sync
  # 或 powershell -ExecutionPolicy Bypass -File .\sync.ps1 -Now
  ```

### 2. 启动 30 分钟定时自动同步守护 (Daemon)
- **方式一**：双击运行 **`start-sync-timer.bat`**。
- **方式二**：命令行运行：
  ```powershell
  npm run sync:watch
  # 或 powershell -ExecutionPolicy Bypass -File .\sync.ps1 -Daemon -IntervalMinutes 30
  ```
- **工作机制**：
  - 每隔 30 分钟自动检查本地修改并提交；
  - 采用 `git pull --rebase` 拉取 GitHub 远端代码，保持提交记录整洁平直；
  - 自动推送本地提交至 GitHub。

---

## 📡 API 端点列表 (OpenAI 兼容)

服务默认监听：`http://127.0.0.1:8765`

### 1. 健康检查
- **端点**：`GET /health` 或 `GET /`
- **响应**：
```json
{
  "status": "ready",
  "initError": null,
  "message": "ChatGPT OpenAI Bridge is online and ready",
  "port": 8765
}
```

### 2. 模型列表
- **端点**：`GET /v1/models` 或 `GET /models`
- **支持模型**：`chatgpt-plus`, `gpt-4o`, `gpt-4o-mini`, `gpt-5-6`

### 3. 对话补全 (Chat Completions)
- **端点**：`POST /v1/chat/completions` 或 `POST /chat/completions`
- **请求头**：`Content-Type: application/json`
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

### 4. 实时日志查询
- **端点**：`GET /logs`
- 可在浏览器中实时刷新查看服务端的最新调度日志与工具授权记录。

---

## 🧪 自动化测试验证

运行内置的端到端自动化测试套件：
```powershell
node .\test-api.mjs
```

测试覆盖：
- `[Test 1]` GET /health（状态 ready 检测）
- `[Test 2]` GET /v1/models（模型清单拉取）
- `[Test 3]` POST /v1/chat/completions（非流式请求验证）
- `[Test 4]` POST /v1/chat/completions（SSE 流式逐块接收验证）

---

## 🛠️ 第三方客户端接入指南

在 **燕子 (Yanzi)**、**Cherry Studio**、**NextChat** 等客户端中添加自定义 OpenAI 提供商：
- **API Base URL**：`http://127.0.0.1:8765/v1`（或 `http://127.0.0.1:8765`）
- **API Key**：任意填写（如 `sk-ego-local`）
- **模型名称**：`chatgpt-plus` / `gpt-4o`

---

## 📄 开源许可证

本项目基于 [MIT License](LICENSE) 开源。
