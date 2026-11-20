# Piggy

Piggy 是自用的 Android 聊天应用。APK 随附官方 `@earendil-works/pi-agent-core` 1.5.2。APK 内置 Node.js/V8（Javet Android），在应用进程内执行本地 JavaScript，Kotlin 通过 HTTPS 直连 OpenAI，按流显示回复。安装后可在能访问 OpenAI 的网络上直接对话。支持 Android 7.0 及以上的 ARM64 和 x86_64 设备。

## 构建个人 APK

使用 Node.js 24、JDK 21、Android SDK 36 和 Gradle Wrapper。在项目根目录执行：

```sh
(cd mobile-agent && npm ci)
cd android
PI_API_KEY_FILE=/path/to/private-key.txt ./gradlew :app:assembleDebug
```

文件应仅包含个人 OpenAI API Key，也可由构建进程的 `PI_API_KEY` 环境变量提供。调试包位于 `android/app/build/outputs/apk/debug/app-debug.apk`。APK 和 Android 构建目录中都包含可提取的 Key，请仅自己保管。轮换 Key 后重新构建并安装。发布构建可使用 `:app:assembleRelease` 并以自己的 Android 签名密钥签名。

## 运行结构

- `mobile-agent/runtime.js` 使用 Pi 的 Agent、OpenAI Chat Completions 适配器和流式事件。默认模型是 `gpt-4.1-mini`。所有官方 Core 运行时导出均作为 `globalThis.PiAgentCore` 提供给本地扩展；构建脚本从锁定的 npm 包生成导出清单，应用启动时核对。
- `MobileAgent.kt` 只向固定的 OpenAI HTTPS 地址附加凭证，保留系统证书和主机名验证。Pi 在专用线程运行。模型请求由 Kotlin 执行，Key 不会作为 JavaScript 的参数传递。
- 一个聊天界面对应一个内存会话。点“新对话”重置上下文；关闭界面后清空。普通失败可重新发送。
- `server/` 提供独立的网页版聊天管理端，复用官方 Pi Agent 和 OpenAI 适配器。手机端和管理端各自维护对话。

## 网页管理端

服务只需一个 Node.js 24 进程，默认监听 `127.0.0.1:8888`。在 `server/` 中执行 `npm ci --omit=dev`，配置 `PI_API_KEY` 后执行 `npm start`。浏览器打开 `http://127.0.0.1:8888` 即可对话。页面支持流式回复和新建对话，刷新后开始新的会话。

公网部署时，将 `server/` 及其生产依赖放在 `/opt/piggy/server/`，使 systemd 能从系统路径找到 Node.js 24。将域名或 IP 对应的 TLS 证书链与私钥分别放在 `/etc/piggy/fullchain.pem`、`/etc/piggy/privkey.pem`。配置仅 root 可读的 `/etc/piggy/server.env`，其中包含 `PI_API_KEY` 和单独的 `PIGGY_ADMIN_PASSWORD`。将 `server/deploy/piggy.service` 安装到 `/etc/systemd/system/`，运行 `systemctl daemon-reload` 和 `systemctl enable --now piggy`。安全组与主机防火墙需允许 TCP 8888。浏览器通过 HTTPS 访问，用户名为 `piggy`。轮换证书后重启服务。

部署前后可用 `awk '/^MemTotal:/{t=$2} /^MemAvailable:/{a=$2} END{printf "%.1f%% used\n",100*(1-a/t)}' /proc/meminfo` 检查整机内存，并用 `systemctl show piggy -p MemoryCurrent -p MemoryPeak` 检查服务用量。服务最多同时生成 2 个回复，保留 8 个会话，每个请求最多携带最近 12 轮历史。Linux 上剩余可用内存低于总量的一半加 32 MiB 时，会暂停接受新对话请求。systemd 单元以 160 MiB 为软限制，224 MiB 为硬限制，应按目标机器的实测余量下调。
