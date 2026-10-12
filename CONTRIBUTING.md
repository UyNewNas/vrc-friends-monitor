# 贡献指南

请围绕好友状态、桌面通知、日志和相关可靠性改进提交变更。使用 Windows、.NET 10 SDK、PowerShell 7，运行 README 中的构建、测试和隐私检查。

浏览器扩展源码位于 `browser-extension/`，开发检查使用 Node.js 22 或更新版本，无需安装 npm 依赖。在该目录依次运行 `npm run check`、`npm test` 和 `npm run package`；Windows 构建和仓库隐私检查仍须通过。扩展的浏览器界面烟测、真实扩展会话烟测（`npm run smoke:session`，需要 Chrome / Chromium 与 OpenSSL）与后端行为测试都使用合成数据，不能作为真实账号登录或持续在线的证据。

测试必须使用模拟账号、好友和网络响应。不要提交真实密码、验证码、Cookie、账号配置、好友日志、用户截图、编译输出或本机路径。新增日志字段时需说明用途和存储方式。

提交 PR 时说明解决的问题、变更后的行为及验证结果。修改发布方式或使用步骤时同步更新文档。提交记录建议使用 GitHub 的 noreply 邮箱，避免公开个人邮箱。

`--self-test` 执行离线功能检查；`--render-preview` 使用示例数据执行界面交互检查并绘制预览。它们均不会登录真实账号，复制按钮检查也不会改动系统剪贴板。
