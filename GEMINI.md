# Project & Workspace Memory (项目环境与身份凭据)

## 托管平台与认证凭据
- **Gitee 账号**：`shiyiwu`（认证凭据读取系统环境变量 `$env:GITEE_TOKEN` 及本地 `.env`）
- **GitHub 账号**：`luoluoluo22`（认证凭据读取系统环境变量 `$env:GITHUB_TOKEN` 及本地 `.env`）
- **环境规范**：已在 Windows 全局环境变量、当前目录 `.env` 及 Git 凭据助手 (`store`) 中完全注入。在执行 Gitee/GitHub 任何拉取、推送、创建或 API 调用时，直接使用内置环境变量与凭据助手。
