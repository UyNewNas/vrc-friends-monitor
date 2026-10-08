# 版本发布

版本来源为 `src/VRCFriendsMonitor/VRCFriendsMonitor.csproj` 的 `<Version>`。

1. 先构建本地体验版，更新本地启动入口，由用户试用登录、好友列表和通知等主要功能。
2. 用户确认可以发布后，更新正式版本及相关文档，将修改合并到 `main`。
3. 确认 `main` 的 CI 已通过。
4. 在对应提交上创建与项目版本完全一致的标签并推送，例如：

```powershell
git switch main
git pull --ff-only
git tag v1.3.0
git push origin v1.3.0
```

Release 工作流会检查标签格式、版本一致性和提交是否属于 `main`，然后调用 CI 构建与测试。发布任务只在所有检查成功后运行，验证 SHA-256，并发布 ZIP 与校验文件。

ZIP 固定包含 `VRChatFriendNotifier.exe`、`LICENSE`、`README.md` 和 `QUICKSTART.txt`。不会将源码目录、测试文件、日志、用户设置或调试符号打包。

预发布示例：项目版本 `1.4.0-rc.1` 对应标签 `v1.4.0-rc.1`，自动标记为 prerelease。不要覆盖已有发布标签；修复后发布新版本。构建失败可修复后重跑工作流，发布失败请先确认同名 Release 是否已经创建。

维护 GitHub Actions 时保留完整提交 SHA、最小权限和 `persist-credentials: false`。无需新增 VRChat 账号或 Personal Access Token。Dependabot 每周检查 Actions 更新。
