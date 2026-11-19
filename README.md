# Piggy

Kotlin Android 客户端通过本机端口连接 Node.js 后端，由 pi-agent-core 调用 OpenAI。支持流式文本、多轮上下文和新建对话。每个会话独立保存在后端内存中，空闲一小时过期，服务重启后清空。

## 启动后端

在 server 目录使用 Node.js 24.5 或更高版本，执行以下命令。启动进程从环境变量 PI_API_KEY 读取 OpenAI 密钥，默认模型为 gpt-4.1-mini，可通过 PI_MODEL 指定支持 Chat Completions 的 OpenAI 模型。

```sh
npm ci
npm start
```

服务监听 127.0.0.1:8787，用于本机开发和 adb 联调。执行 `node --test chat.test.ts` 可在本机用模拟模型验证流式回复，以及生成失败后的多轮上下文。

## 在 Android 上运行

在 android 目录使用 JDK 21、Android SDK 36 和已连接的模拟器或 USB 调试设备执行以下命令。adb 和后端需要在同一台开发机运行。

```sh
./gradlew :app:assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb reverse tcp:8787 tcp:8787
adb shell am start -n dev.pichat/.ChatActivity
```

设备通过 adb 转发访问后端。断开调试连接后，需要重新建立端口转发。手机端仅在当前界面保留聊天记录。
