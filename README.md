# Piggy

Android 在同一段对话中持续发送消息，由美国 CVM 上的 Pi Agent 生成流式回复。网页是手机对话的只读记录。浏览器登录后按时间查看提问、回复和失败状态，每三秒读取新增或刚完成的记录，支持向前翻页。

```text
手机 → HTTPS 8888 → Go → Pi → OpenAI
                          ↕
                       SQLite
只读网页 → Go → 经鉴权的历史查询
```

服务端在调用模型前写入提问，结束时保存回复或失败状态。服务中断遗留的进行中记录在启动时标记失败。完整记录存储在 `/var/lib/piggy-journal/chat.sqlite`，使用 SQLite WAL，可跨发布和服务重启保留。只有登录后的网页可以读取完整记录。手机保留本次安装的对话编号和最近 40 轮成功问答，重新打开可继续。模型从数据库读取该手机对话最近 12 轮成功上下文。手机清除数据或重装后，网页仍保留服务器上的记录，手机的本地记录和对话编号会重置。

## Android

使用 JDK 17、Android SDK 36 和仓库内的 Gradle Wrapper。

```sh
cd android
./gradlew :app:assembleDebug
```

调试包位于 `app/build/outputs/apk/debug/app-debug.apk`。分发时构建 `:app:assembleRelease`，用自己的 Android 发布密钥通过 `zipalign`、`apksigner` 签名。更新已安装应用需要相同签名。手机首次打开即可对话。APK 通过公网 HTTPS 向 `POST /mobile/chat` 发送消息，该接口允许匿名调用。网页使用只读的 `GET /history`，需要管理员登录。旧网页发送接口已关闭。

## CVM 部署

在开发机运行 `server/admin/build-release.sh /path/to/output` 构建 Vue 静态文件、Linux x86-64 Go 程序和服务端 Pi bundle。将发布目录放到 `/lighten012/projects/Piggy/releases/<revision>`，让 `current` 指向该版本。在 `runtime/node` 安装 Node.js 24。使用仅 root 可读的 `server.env` 配置以下变量。

| 变量 | 用途 |
|---|---|
| PI_API_KEY | Pi 专用的 OpenAI 密钥 |
| PI_MODEL | 可选，默认 gpt-4.1-mini |
| PIGGY_ADMIN_PASSWORD | 网页账号 piggy 的独立密码 |
| PIGGY_WORKER_TOKEN | Go 与 Pi 之间的随机内部密钥 |

安装发布目录内的两个 systemd 单元，执行 `systemctl daemon-reload`、`systemctl enable --now piggy-pi piggy-admin`。已有服务切换版本后重启两个单元。按 `server/admin/nginx.conf.example` 配置本站证书和 HTTPS 8888。Go 不接收模型密钥，Pi 不接收网页密码。

Pi 的 systemd 日志记录手机模型调用结果、耗时和 token 用量。可通过 `journalctl -u piggy-pi` 查看。

## 资源限制与测试

Linux 可用内存低于总量一半加 32 MiB 时，Pi 暂停接受新消息。Go 服务的软/硬限制为 80/112 MiB，Pi 服务为 160/224 MiB。可用 `systemctl show piggy-pi piggy-admin -p MemoryCurrent -p MemoryMax` 查看服务用量。

```sh
(cd server/admin && go test -race ./...)
(cd server && npm ci && node --test chat.test.ts)
```
