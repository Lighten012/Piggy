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
- `server/` 保留早期 Node.js 后端实现和测试，当前 APK 独立运行。
