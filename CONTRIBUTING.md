# 贡献指南

浏览器扩展是本项目的主要版本，后续功能优先在 `browser-extension/` 开发。请围绕好友状态、提醒、本地记录和同步可靠性提交变更。Windows 客户端源码继续保留在 `src/VRCFriendsMonitor/`，使用与构建说明见 [Windows 客户端文档](docs/WINDOWS_CLIENT.md)。

## 开发与验证

扩展开发要求 Node.js 22 或更新版本，无需安装 npm 依赖。在 `browser-extension/` 依次运行 `npm run check`、`npm test`、`npm run smoke:session`、`npm run smoke` 和 `npm run package`。两项浏览器烟测需要 Chrome / Chromium，会话烟测还需要 OpenSSL。

Windows 兼容性构建、自测和仓库隐私检查仍须通过，使用 Windows、.NET 10 SDK 与 PowerShell 7。浏览器扩展 CI 会调用既有 Windows CI；改变根目录文档时，也要检查 Windows 安装包中的文档是否仍正确。

扩展的界面烟测、真实安装扩展的会话烟测与行为测试均使用合成数据，不能作为真实账号长时间在线或所有服务器策略兼容的证据。

## 数据与提交

测试必须使用模拟账号、好友和网络响应。不要提交真实密码、验证码、Cookie、账号配置、好友日志、用户截图、编译输出或本机路径。新增日志字段时需说明用途和存储方式。

提交 PR 时说明解决的问题、变更后的行为及验证结果，区分自动测试与实际使用反馈。修改安装、更新、运行条件或发布流程时同步更新文档。提交记录建议使用 GitHub 的 noreply 邮箱，避免公开个人邮箱。

Windows 客户端的 `--self-test` 执行离线功能检查；`--render-preview` 使用示例数据执行界面交互检查并绘制预览。它们均不会登录真实账号，复制按钮检查也不会改动系统剪贴板。
