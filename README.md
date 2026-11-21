# Piggy

Android 在同一段对话中持续发送消息，由美国 CVM 上的 Pi Agent 生成流式回复。网页是手机对话的只读记录。浏览器登录后按时间查看提问、回复和失败状态，每三秒读取新增或刚完成的记录，支持向前翻页。

```text
手机 → HTTPS 8888 → Go → Pi → OpenAI
                          ↕
                       SQLite
只读网页 → Go → 经鉴权的历史查询与 Agent 能力清单
```

服务端在调用模型前写入提问，结束时保存回复或失败状态。服务中断遗留的进行中记录在启动时标记失败。完整记录存储在 `/var/lib/piggy-journal/chat.sqlite`，使用 SQLite WAL，可跨发布和服务重启保留。只有登录后的网页可以读取完整记录。手机保留本次安装的对话编号和最近 40 轮成功问答，重新打开可继续。网页从 turns 表读取聊天原文。模型和圆环读取独立的 active_context 表，按顺序使用该对话的全部工作上下文。每轮成功后，原文和新增上下文在同一个事务中保存。首次升级时一次性导入已有成功轮次的上下文。聊天顶栏的圆环按 300,000 个输入 token 显示用量，点击可查看明细。服务端在每次生成前对实际 Responses 输入（含附件）调用 OpenAI 计数，超限或计数失败时保留草稿并提示。手机清除数据或重装后，网页仍保留服务器上的记录，手机的本地记录和对话编号会重置。

## Android

使用 JDK 17、Android SDK 36 和仓库内的 Gradle Wrapper。

```sh
cd android
./gradlew :app:assembleDebug
```

调试包位于 `app/build/outputs/apk/debug/app-debug.apk`。分发时构建 `:app:assembleRelease`，用自己的 Android 发布密钥通过 `zipalign`、`apksigner` 签名。更新已安装应用需要相同签名。手机首次打开即可对话。APK 通过公网 HTTPS 向 `POST /mobile/chat` 发送消息，该接口允许匿名调用。网页使用只读的 `GET /history`，需要管理员登录。旧网页发送接口已关闭。

### 联网搜索

手机可以直接问「今天有哪些重大新闻？」或要求联网核实资料。服务端在 Responses API 中启用 OpenAI 的 `web_search`，将来源链接随回答写入聊天记录。手机和网页可点开引用。网页管理端的工具清单会显示联网搜索。相对日期默认按北京时间理解。

### 助手回复的附件

可以让 Piggy 画图，或生成可下载的 Excel、PowerPoint 等文件。服务端调用 OpenAI 的图片生成或代码解释器工具，取回成品，保存在与用户上传件相同的私有目录。SQLite 保存回复与文件之间的关联、文件名、类型、大小及到期时间。手机点附件进入只读预览页，右上角可以另存原件或用其他应用打开。登录后的网页可以查看和下载。七天后服务器停止提供下载并清理文件，聊天里仍保留文件名。用户主动另存的副本由用户自行管理。

### 聊天附件

输入框左侧的「＋」打开 Android 系统文件选择器，每条消息最多可混合选择 4 个文件，每个不超过 10 MiB。选中的附件显示在输入框内，可分别移除；点击发送立即移入消息，失败时恢复为草稿。可以单独发送文件。手机可在选择和发送图片后查看缩略图；点图片可放大。发送成功后，本机最近 40 轮的图片保留缩略图，其他附件点文件名进入同一预览页。手机保留所选文件的读取权限直到发送成功或移除，失败后可以重试。手机和服务端共用随版本发布的附件格式清单（Android assets 中的 attachment-types.json）。可添加 JPEG、PNG、WebP、静态 GIF、PDF、Office 文档、表格、演示、文本和代码。手机会在上传前提示不支持的文件；多选时保留其余合规文件。

Go 将匿名、带版本号的 `POST /mobile/attachments` 流式转给 Pi。Pi 流式接收文件，上传至 OpenAI Files 后，在 SQLite 所在目录的私有 attachments/ 子目录保留原件七天，并将文件编号、名称、大小、所属对话和过期时间写入 SQLite。迁移时应同时迁移该目录和数据库。OpenAI 文件保留七天。附件和针对最近一组成功发送的附件的追问使用 Responses API，图片按图片输入，其他文件按文档输入。登录管理页可下载原件，图片、PDF 和纯文本类附件还可直接查看。到期后原链接立即失效，后台在启动时及每分钟清理过期原件，聊天记录保留文件名和大小。迁移 Nginx 时一并部署示例配置中的附件 location；普通聊天仍限 32 KiB。

### Android 附件预览

输入框中的附件、已发送文件和 Piggy 的回复附件共用预览页。图片支持缩放，Markdown 按格式阅读，文本和代码按原文阅读。PDF 支持翻页及双指或双击缩放。CSV、TSV、XLS、XLSX 通过 APK 内置的 SheetJS CE 0.20.3 离线读取，可切换工作表并横向滚动；预览显示文件中保存的单元格值。SheetJS 发行源为 `https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js`，许可证随 APK 打包。

打开 DOC、DOCX、PPT、PPTX、ODT、ODP、RTF 时，手机按需将文件传到本机配置的 Piggy CVM。隔离的 LibreOffice 实例把文件排版为静态 PDF，返回后清理临时目录。手机缓存该预览最多七天，回复附件同时受原到期时间限制。转换不调用 OpenAI。预览输入上限 32 MiB，已加密或无法解析的文件会显示提示，并保留原件操作。

## CVM 部署

在开发机运行 `server/admin/build-release.sh /path/to/output` 构建 Vue 静态文件、Linux x86-64 Go 程序和服务端 Pi bundle。将发布目录放到 `/lighten012/projects/Piggy/releases/<revision>`，让 `current` 指向该版本。在 `runtime/node` 安装 Node.js 24。使用仅 root 可读的 `server.env` 配置以下变量。

| 变量 | 用途 |
|---|---|
| PI_API_KEY | Pi 专用的 OpenAI 密钥 |
| PI_MODEL | 可选，默认 gpt-6.2-sol。该模型使用 high 思考强度 |
| PIGGY_ADMIN_PASSWORD | 网页账号 piggy 的独立密码 |
| PIGGY_WORKER_TOKEN | Go 与 Pi 之间的随机内部密钥 |

Debian 预览主机安装 `apt-get install --no-install-recommends libreoffice-writer libreoffice-impress libreoffice-calc fonts-wqy-zenhei`。安装发布目录内三个 systemd 单元，执行 `systemctl daemon-reload`、`systemctl enable --now piggy-preview piggy-pi piggy-admin`。切换版本后重启对应单元。Office 服务通过 Unix socket 接收转换任务，单次处理一份，使用私有网络与临时目录，内存上限 384 MiB。Nginx 需要包含示例中的 `/mobile/preview` location。按 `server/admin/nginx.conf.example` 配置本站证书和 HTTPS 8888。Go 不接收模型密钥，Pi 不接收网页密码。

Pi 的 systemd 日志记录手机模型调用结果、耗时和 token 用量。可通过 `journalctl -u piggy-pi` 查看。

## 资源限制与测试

Linux 可用内存低于总量一半加 32 MiB 时，Pi 暂停接受新消息。Go 服务的软/硬限制为 80/112 MiB，Pi 服务为 160/224 MiB。可用 `systemctl show piggy-pi piggy-admin -p MemoryCurrent -p MemoryMax` 查看服务用量。

```sh
(cd server/admin && go test -race ./...)
(cd server && npm ci && node --test chat.test.ts)
```

## Android 应用内更新

手机在进程冷启动时自动检查版本，同一进程验证通过后，选择附件、取消选择或切回前台会直接回到聊天。只有本机版本与已发布版本匹配时才进入聊天；发现新版会自动下载并校验，取消安装时停留在更新页，网络失败可重试。Go 按已发布的 versionCode 检查聊天及附件上传请求；旧版收到 HTTP 426，触发重新检查。聊天地址和更新地址均取自 APK 的固定 HTTPS 源。首次允许 Piggy 安装应用以及系统要求的安装确认由用户完成。已有 0.3.0 或更早版本需要先手动覆盖安装一次支持更新的版本。后续覆盖升级保留本机对话数据。

Go 网关原生提供三个公开只读地址，手机免登录。网页管理和对话记录仍需登录。

| 地址 | 用途 |
|---|---|
| `/updates/android/latest.json` | 最新版本号、最低 Android 版本、签名摘要、文件大小和 SHA-256 |
| `/updates/android/Piggy.apk` | 首次安装的稳定下载链接 |
| `/updates/android/<sha256>.apk` | 不可变安装包，下载中切换版本也不会拿错文件 |

发布新版本时，递增 Android 的 `versionCode`，使用原 Piggy 发布密钥签名。在开发机运行以下命令，脚本会用 Android SDK 验证签名并从 APK 提取元数据。

```sh
python3 server/admin/prepare-android.py Piggy-signed.apk android-bundle --build-tools "$ANDROID_HOME/build-tools/36.0.0"
```

将生成的 `android-bundle` 目录上传到服务器，再执行以下命令。发布命令串行校验版本、签名摘要和文件哈希，完整写入 APK 后原子切换版本清单，服务运行期间即可发布。

```sh
/lighten012/projects/Piggy/current/piggy-admin publish-android /path/to/android-bundle
```

版本清单和 APK 默认放在 `/lighten012/projects/Piggy/updates/android`，独立于服务端代码版本；可通过 `PIGGY_UPDATES_DIR` 调整，发布命令与 systemd 服务需使用同一目录。迁移时复制此目录及原有聊天数据、配置，部署相同网关并保留原发布签名。迁移时沿用固定公网地址和端口；如将来确需更改地址，需在原地址发布配置了新地址的签名 APK。
