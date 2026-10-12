# 版本发布

## 浏览器扩展：主要版本

浏览器扩展是项目的主要版本和后续开发方向。扩展版本由 `browser-extension/manifest.json` 与 `browser-extension/package.json` 共同声明，两处必须一致。

1. 在开发分支完成修改，运行扩展静态检查、离线测试与打包；检查真实扩展会话和界面烟测结果。
2. 提交 PR，确认 `Browser extension` 工作流及 Windows 兼容性检查通过，再由用户安装对应提交的扩展包，验证登录同步、通知和中断恢复。
3. 用户测试通过后合并到 `main`，确认合并提交的检查通过。
4. 从 [Browser extension 工作流](https://github.com/UyNewNas/vrc-friends-monitor/actions/workflows/browser-extension.yml) 中选择对应提交，下载 `vrc-friends-monitor-chromium` artifact，核对包内 SHA-256。安装步骤见 [扩展使用说明](https://github.com/UyNewNas/vrc-friends-monitor/blob/main/browser-extension/README.md)。

当前扩展通过源码或 CI 安装包分发，尚未发布到浏览器扩展商店，也没有自动创建扩展 GitHub Release 的工作流。CI artifact 当前保留 14 天；过期后可从对应提交重新打包。扩展 ZIP 只包含运行时文件、许可证和扩展使用说明。

`v*` 标签仍触发下面的 Windows 发布流程，不能用它发布扩展版本。扩展分发流程与 Windows 版本号彼此独立。

## Windows 客户端：现有发布流程

Windows 版本来源为 `src/VRCFriendsMonitor/VRCFriendsMonitor.csproj` 的 `<Version>`。桌面客户端的构建与测试继续保留，使用说明见 [Windows 客户端](https://github.com/UyNewNas/vrc-friends-monitor/blob/main/docs/WINDOWS_CLIENT.md)。

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

Windows ZIP 固定包含 `VRChatFriendNotifier.exe`、`LICENSE`、`README.md` 和 `QUICKSTART.txt`。包内 `README.md` 取自 `docs/WINDOWS_CLIENT.md`，提供对应的桌面客户端说明。不会将源码目录、测试文件、日志、用户设置或调试符号打包。

预发布示例：项目版本 `1.4.0-rc.1` 对应标签 `v1.4.0-rc.1`，自动标记为 prerelease。不要覆盖已有发布标签；修复后发布新版本。构建失败可修复后重跑工作流，发布失败请先确认同名 Release 是否已经创建。

维护 GitHub Actions 时保留完整提交 SHA、最小权限和 `persist-credentials: false`。无需新增 VRChat 账号或 Personal Access Token。Dependabot 每周检查 Actions 更新。
