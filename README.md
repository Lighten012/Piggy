# Piggy

Android 原生客户端和 Vue 网页共用美国 CVM 上的 Pi Agent。手机仅与 Piggy 的 HTTPS 服务通信，APK 不包含模型密钥或 Node.js 运行时。两端使用相同的模型和提示词，各自的会话按身份隔离。

```text
Android / Vue → Nginx (HTTPS 8888) → Go (回环 18888) → Pi Agent (回环 18889) → OpenAI
```

Go 负责网页、管理员登录、设备绑定与转发。Pi 服务持有模型密钥、管理会话并返回流式回复。两者由 systemd 管理。Pi 最多同时生成两条回复，保存八个会话，每个保留最近十二轮成功问答。会话空闲一小时后在后续请求中清理，重启 Pi 会丢失上下文。浏览器刷新或手机重新打开聊天界面会开始新会话。设备授权跨服务重启保留。

## Android

使用 JDK 17、Android SDK 36 和仓库内的 Gradle Wrapper。

```sh
cd android
./gradlew :app:assembleDebug
```

调试包位于 `app/build/outputs/apk/debug/app-debug.apk`。分发时构建 `:app:assembleRelease`，用自己的 Android 发布密钥通过 `zipalign`、`apksigner` 签名。更新已安装应用需要相同签名。首次打开时填写单独发放的邀请码。清除应用数据或重新安装后需新邀请码。

## CVM 部署

在开发机运行 `server/admin/build-release.sh /path/to/output` 构建 Vue 静态文件、Linux x86-64 Go 程序和服务端 Pi bundle。将发布目录放到 `/lighten012/projects/Piggy/releases/<revision>`，让 `current` 指向该版本。在 `runtime/node` 安装 Node.js 24。使用仅 root 可读的 `server.env` 配置以下变量。

| 变量 | 用途 |
|---|---|
| PI_API_KEY | Pi 专用的 OpenAI 密钥 |
| PI_MODEL | 可选，默认 gpt-4.1-mini |
| PIGGY_ADMIN_PASSWORD | 网页账号 piggy 的独立密码 |
| PIGGY_WORKER_TOKEN | Go 与 Pi 之间的随机内部密钥 |

安装发布目录内的两个 systemd 单元，执行 `systemctl daemon-reload`、`systemctl enable --now piggy-pi piggy-admin`。已有服务切换版本后重启两个单元。按 `server/admin/nginx.conf.example` 配置本站证书和 HTTPS 8888。Go 不接收模型密钥，Pi 不接收网页密码。设备绑定保存在 systemd 的 `/var/lib/piggy-admin`，授权清单保存在项目的 `devices/`。保留两个目录即可保留原有设备授权。

## 发放与撤销设备

在 CVM 的 `/lighten012/projects/Piggy/current` 目录，以 root 执行：

```sh
python3 device.py issue '设备备注'
python3 device.py list
python3 device.py revoke <完整设备ID>
```

issue 只显示一次邀请码。每份邀请码仅能绑定一个安装实例，重复绑定会拒绝。撤销在该设备的下一次请求生效。不要向设备使用者分发网页管理密码。Pi 的 systemd 日志记录完成的请求归属、时间、结果、输入和输出 token 数，避免记录消息正文或密钥。查看日志可运行 `journalctl -u piggy-pi`。

## 资源限制与测试

Linux 可用内存低于总量一半加 32 MiB 时，Pi 暂停接受新消息。Go 服务的软/硬限制为 80/112 MiB，Pi 服务为 160/224 MiB。可用 `systemctl show piggy-pi piggy-admin -p MemoryCurrent -p MemoryMax` 查看服务用量。

```sh
(cd server/admin && go test -race ./...)
(cd server && npm ci && node --test chat.test.ts)
```
