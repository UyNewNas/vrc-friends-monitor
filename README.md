# VRC Friends Monitor

[![Browser extension CI](https://github.com/UyNewNas/vrc-friends-monitor/actions/workflows/browser-extension.yml/badge.svg)](https://github.com/UyNewNas/vrc-friends-monitor/actions/workflows/browser-extension.yml)
[![Windows compatibility CI](https://github.com/UyNewNas/vrc-friends-monitor/actions/workflows/ci.yml/badge.svg)](https://github.com/UyNewNas/vrc-friends-monitor/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

VRChat 好友状态监控工具。**浏览器扩展是项目的主要版本，后续功能优先围绕 Chrome / Edge 扩展开发。** 当前扩展版本为 **0.1.1**，使用日常浏览器中的 VRChat 官网登录会话，提供好友状态、按好友设置的上下线提醒和本地动态记录。

Windows 客户端的源码、既有下载和兼容性检查继续保留，使用与构建说明见 [Windows 客户端文档](docs/WINDOWS_CLIENT.md)。

## 安装浏览器扩展

适用于 **Chrome / Edge 120 及以上版本**，目前通过「加载已解压的扩展程序」安装。

1. 打开 [Browser extension 工作流](https://github.com/UyNewNas/vrc-friends-monitor/actions/workflows/browser-extension.yml)，选择对应分支或 PR 中已通过检查的构建，下载 `vrc-friends-monitor-chromium` artifact。
2. 解压外层 ZIP，再解压其中的 `VRC-Friends-Monitor-0.1.1-chromium.zip`。安装目录应直接包含 `manifest.json`。
3. Chrome 打开 `chrome://extensions`，Edge 打开 `edge://extensions`，开启「开发者模式」，点击「加载已解压的扩展程序」并选择安装目录。
4. 在同一个浏览器配置文件中打开 [VRChat 官网](https://vrchat.com/home)，登录并完成官网要求的验证。**如果官网之前已经打开，请刷新一次，并保留这个标签页。**
5. 打开扩展，点击「立即同步」，然后在完整面板中为需要关注的好友勾选上线 / 离线提醒。

也可以从当前分支下载源码，直接加载 [browser-extension](browser-extension) 文件夹；安装使用无需 Node.js 或构建步骤。更新时覆盖原扩展目录，在扩展管理页点击「重新加载」，**再刷新官网标签页一次**。

完整安装步骤、异常处理和权限说明见 **[浏览器扩展使用说明](browser-extension/README.md)**。扩展的分发入口目前是通过 CI 检查的安装包或源码，尚未发布到扩展商店；现有 `v*` 标签发布流程对应 Windows 客户端，见 [发布指南](docs/RELEASING.md)。

## 主要功能

- 查看游戏在线、网页活跃、离线和状态未知的好友，支持名称 / ID 搜索及状态筛选。
- 为每位好友分别设置游戏上线、离线的桌面通知。
- 在完整面板查看本地动态记录；规则和历史按账号区分。
- 默认每分钟同步一次，可调整为 2 或 5 分钟；支持暂停和手动同步。
- 保存重试计划，在后台恢复、断网恢复和官网页面重新就绪后继续同步。

首次同步、手动同步、切换账号以及中断后的首次恢复会静默建立基准，避免一次性补发上下线通知。个别好友的状态分类暂时缺失或冲突时显示「状态未知」，不会据此制造上线或离线记录。

## 运行条件

需要保留至少一个已登录的 VRChat 官网标签页，它可以放在后台；扩展弹窗和完整面板可以关闭。浏览器完全退出、电脑休眠、页面冻结或网络中断期间无法持续同步，恢复后会保留旧结果并重新建立基准。

记录时间是扩展检测到变化的时间。两次轮询之间短暂上线又离线的变化可能被漏过，扩展不保证实时或无遗漏。这是浏览器桌面通知，VR 头显内及独占全屏下不保证可见。

0.1.1 使用官网页面中的同源请求修复了旧版后台请求可能在官网已登录时仍返回 403 的连接路径。官网自身的登录与验证仍由用户在正常页面中完成。

## 本地数据与隐私

扩展只在当前浏览器配置文件的本地存储中保存必要的账号 / 好友 ID、显示名、状态、提醒规则、有限历史与重试信息。不收集密码或验证码，不读取、复制或保存认证 Cookie，不保存完整登录响应，不上传好友动态记录。

网站访问范围仅限 `vrchat.com`。官网页面内的隔离脚本只处理当前账号和好友分页两类只读请求，返回前先裁剪数据。具体权限及清理方法见 [扩展本地数据说明](browser-extension/README.md#本地数据与权限)。

## 开发与验证

扩展开发需要 Node.js 22 或更新版本，无需安装 npm 依赖：

```sh
cd browser-extension
npm run check
npm test
npm run smoke:session
npm run smoke
npm run package
```

两项浏览器烟测需要已安装的 Chrome / Chromium，真实扩展会话烟测还需要 OpenSSL。测试使用临时配置文件和合成数据；会话烟测实际安装扩展，通过仅本地可达的 HTTPS 测试站点验证消息、浏览器 Cookie、同源请求与好友分页。

[Browser extension CI](https://github.com/UyNewNas/vrc-friends-monitor/actions/workflows/browser-extension.yml) 执行扩展检查、测试、界面 / 会话烟测和打包，并继续执行 Windows 构建与隐私审计。检查通过的扩展 ZIP 和 SHA-256 校验文件作为 Actions 产物提供。

## 贡献与许可

欢迎提交 Issue 和 PR。请阅读 [贡献指南](CONTRIBUTING.md)、[安全说明](SECURITY.md) 和 [发布指南](docs/RELEASING.md)。本项目以 [MIT License](LICENSE) 发布，与 VRChat 官方无关联。

接口参考：[登录](https://vrchat.community/reference/get-current-user)、[好友列表](https://vrchat.community/reference/get-friends)。
