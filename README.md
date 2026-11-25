# Piggy

Android 在同一段对话中持续发送消息，由美国 CVM 上的 Pi Agent 生成流式回复。网页管理端可以查阅手机对话，也可以调整本环境的模型设置。测试管理端的「定时任务」可以让 Piggy 按北京时间主动给该环境唯一绑定的 Android 客户端发消息。浏览器登录后按时间查看提问、回复和失败状态，每三秒读取新增或刚完成的记录，支持向前翻页。

## 开发文档

| 想了解什么 | 从哪里开始 |
|---|---|
| 正式和测试各跑哪个版本、已经验过什么、还有哪些限制 | [项目进展](docs/status.md) |
| 一次改动如何从开发进入测试、何时发布正式版、如何维护文档 | [开发与发布约定](docs/development.md) |
| 为什么部署两套服务、谁持有上下文、附件和更新怎样处理 | [技术决策记录](docs/decisions.md) |

## 系统架构

```text
Android → 固定 HTTPS 入口 → Go 网关 → Pi Agent → OpenAI
网页管理端 → 同环境 Go 网关 → Pi Agent → SQLite 与附件目录
```

服务端在调用模型前写入提问，结束时保存回复或失败状态。服务中断遗留的进行中记录在启动时标记失败。正式环境的完整记录存储在 `/var/lib/piggy-journal/chat.sqlite`，使用 SQLite WAL，可跨发布和服务重启保留。只有登录后的网页可以读取完整记录。手机保留本次安装的对话编号，Android 测试版 53 起把收到的成功问答和定时消息写入本地 SQLite。聊天从最新位置打开，滑动时按每页 24 轮读取，最多缓存三页。升级会导入旧客户端仍保留的最近 40 轮。网页从 turns 表读取聊天原文。模型和圆环读取独立的 active_context 表，按顺序使用该对话的全部工作上下文。每轮成功后，原文和新增上下文在同一个事务中保存。首次升级时一次性导入已有成功轮次的上下文。聊天顶栏的圆环按服务端返回的上限显示用量，测试版为 30,000 个输入 token，正式版为 300,000，点击可查看明细。服务端以最近一次模型回报的实际输入用量为基准，在本地估算新增内容。超过窗口的 80%（测试版 24,000，正式版 240,000 tokens）时后台总结旧历史。手机可以继续收发，摘要完成后供后续请求使用。手机清除数据或重装后，网页仍保留服务器上的记录，手机的本地记录和对话编号会重置。

## 正式环境与测试环境

| | 正式 Piggy | Piggy 测试版 |
|---|---|---|
| 手机与管理页 HTTPS 端口 | 8888 | 8889 |
| Android 包名 | dev.pichat | dev.pichat.staging |
| 网关 / Pi 本机端口 | 18888 / 18889 | 18988 / 18989 |
| 部署根目录 | /lighten012/projects/Piggy | /lighten012/projects/Piggy-staging |
| SQLite 和七天附件目录 | /var/lib/piggy-journal | /var/lib/piggy-staging-journal |

日常构建默认选择测试环境。测试版安装在独立的 Android 应用空间，聊天、远端附件下载、网页管理和应用内更新都使用 8889。文档排版在手机上完成。测试 APK 下载地址为 `https://38.14.232.112:8889/updates/android/Piggy.apk`。每个环境的 Go 发布器只接受对应的 Android 包名。各环境分别校验自己的最新版本。

开发时在新的空输出目录构建服务端，运行 `server/admin/build-release.sh /path/to/staging-release staging`。将产物放入测试根目录的 `releases/<revision>`，校验 `ENVIRONMENT` 和 `REVISION` 后切换该环境的 `current`。测试根目录使用自己的 `runtime/node`、`server.env`、管理员密码和内部令牌。安装生成的 `piggy-staging-pi.service` 和 `piggy-staging-admin.service`，使用对应的 Nginx 示例及主机现有的 TLS 证书。调用该目录下的 `current/piggy-admin publish-android` 发布测试 APK，默认写入测试根目录的 `updates/android`。独立设置 `PI_API_KEY` 可分开上游配额。

正式发布时从选定并已验证的提交重新构建，Gradle 显式指定 `-PpiggyEnvironment=production`，服务端脚本第二个参数显式指定 `production`。对正式根目录执行发布，保留该环境的配置、聊天数据库和附件。Android 发布版本号按各自通道递增。

## Android

使用 JDK 17、Android SDK 36 和仓库内的 Gradle Wrapper。

```sh
cd android
./gradlew :app:assembleDebug
```

调试包位于 `app/build/outputs/apk/debug/app-debug.apk`。分发时构建 `:app:assembleRelease`，用自己的 Android 发布密钥通过 `zipalign`、`apksigner` 签名。更新已安装应用需要相同签名。手机首次打开即可对话。APK 通过公网 HTTPS 向 `POST /mobile/chat` 发送消息，该接口允许匿名调用。网页使用只读的 `GET /history`，需要管理员登录。旧网页发送接口已关闭。

### 手机模型设置

测试版手机从 Piggy 顶栏选择「聊天」或「工作」，两种模式共用对话和记忆。管理员在网页「Agent 能力 → 手机模式」分别设置两种模式的模型、思考强度和回复速度。保存后，该模式的下一条新请求生效；已经开始的回复继续使用原设置。旧设置迁入聊天模式，工作模式初始为 GPT-6.2 Astra、高思考、标准速度。手机首次进入默认聊天，之后记住上次选择。定时任务使用聊天配置。Fast 和 Ultrafast 使用 OpenAI 的加速计费档位。测试管理端可选 GPT-6.2、6.1、6、5.6、5.5、5.4 和 4.1 系列。思考强度和加速档位随所选模型更新。

### 保存和查找记忆

用户明确要求记住或更正时，服务端将原话整理为独立事实。例如喜欢草莓和喜欢橙子分别保存；“出差带两万毫安的充电宝”作为一条保存。每条保留证据摘录和来源轮次。明确改口时更新对应事实。

每条事实单独建立向量索引。用自然语言查询时，每次最多返回 20 条相关记忆，可能漏掉其他条目。网页管理端的「Agent 能力」展示记忆 Skill 和工具。

### 管理 Skill

每个已发布的技能来自 `server/skills/<技能名>/SKILL.md`。文件顶部的 YAML 声明 `name` 和 `description`，目录名与 `name` 一致。Markdown 正文作为模型指令，也显示在网页「Agent 能力 → Skills」。发布脚本把 `skills/` 和 `pi.mjs` 一起交付；服务启动时读取这些文件。工具的参数与执行逻辑仍由服务端代码定义。

编写时遵循 [Agent Skills 文件规范](https://agentskills.io/specification)。构建时校验目录名、必填字段、长度和正文，管理页按 CommonMark 排版，另支持表格、删除线，原始 HTML 以文本展示。

### 联网搜索

手机可以直接问「今天有哪些重大新闻？」或要求联网核实资料。服务端在 Responses API 中启用 OpenAI 的 `web_search`，将来源链接随回答写入聊天记录。手机和网页可点开引用。网页管理端的工具清单会显示联网搜索。相对日期默认按北京时间理解。

### 助手回复的附件

可以让 Piggy 画图，或生成可下载的 Excel、PowerPoint 等文件。服务端调用 OpenAI 的图片生成或代码解释器工具，取回成品，保存在与用户上传件相同的私有目录。SQLite 保存回复与文件之间的关联、文件名、类型、大小及到期时间。手机点附件进入只读预览页，右上角可以另存原件或用其他应用打开。登录后的网页可以下载原件。七天后服务器停止提供下载并清理文件，聊天里仍保留文件名。用户主动另存的副本由用户自行管理。

### 聊天附件

输入框左侧的「＋」打开 Android 系统文件选择器，每条消息最多可混合选择 4 个文件，每个不超过 10 MiB。选中的附件显示在输入框内，可分别移除；点击发送立即移入消息，失败时恢复为草稿。可以单独发送文件。手机可在选择和发送图片后查看缩略图；点图片可放大。发送成功后，测试版会为本机聊天记录里的图片保留缩略图，其他附件点文件名进入同一预览页。手机保留本地历史附件的读取权限，移除未发送且未被历史引用的附件时释放权限，失败后可以重试。手机和服务端共用随版本发布的附件格式清单（Android assets 中的 attachment-types.json）。可添加 JPEG、PNG、WebP、静态 GIF、PDF、Office 文档、表格、演示、文本和代码。手机会在上传前提示不支持的文件；多选时保留其余合规文件。

Go 将匿名、带版本号的 `POST /mobile/attachments` 流式转给 Pi。Pi 流式接收文件，上传至 OpenAI Files 后，在 SQLite 所在目录的私有 attachments/ 子目录保留原件七天，并将文件编号、名称、大小、所属对话和过期时间写入 SQLite。迁移时应同时迁移该目录和数据库。OpenAI 文件保留七天。附件和针对最近一组成功发送的附件的追问使用 Responses API，图片按图片输入，其他文件按文档输入。登录管理页可下载原件。到期后原链接立即失效，后台在启动时及每分钟清理过期原件，聊天记录保留文件名和大小。迁移 Nginx 时一并部署示例配置中的附件 location；普通聊天仍限 32 KiB。

### Android 附件预览

输入框中的附件、已发送文件和 Piggy 的回复附件共用预览页。图片支持缩放，Markdown 按格式阅读，文本和代码按原文阅读。PDF 支持翻页及双指或双击缩放。放大后按可见区域重新渲染。CSV、TSV 使用内置的 SheetJS 查看。Excel、Word、PPT、RTF 和 OpenDocument 由 APK 内置的 LibreOfficeKit 26.2.7.3 直接打开原件并绘制屏幕上的区域。工作表可切换并横向、纵向滚动，保留合并单元格、颜色、图片和图表。Word 按原页阅读，PPT 逐张播放静态幻灯片。首次打开在应用私有目录解包，仅在阅读时启动独立进程。回复原件受七天到期时间限制，另存始终使用原件。

构建时 Gradle 运行 `android/prepare-office.py`，从 F-Droid 下载固定哈希的 LibreOffice Android 发行包。默认 CPU 为 arm64-v8a，使用 `-PofficeAbi=armeabi-v7a`、`x86` 或 `x86_64` 构建相应版本。资源、字体和对应架构的引擎均随安装包交付，预览时无需访问网络。上游源代码、许可和对应构建记录见 Android assets 中的 `office-notice.txt`。

## CVM 部署

正式部署时，在开发机运行 `server/admin/build-release.sh /path/to/output production` 构建 Vue 静态文件、Linux x86-64 Go 程序和服务端 Pi bundle。将发布目录放到 `/lighten012/projects/Piggy/releases/<revision>`，让 `current` 指向该版本。在 `runtime/node` 安装 Node.js 24。使用仅 root 可读的 `server.env` 配置以下变量。

| 变量 | 用途 |
|---|---|
| PI_API_KEY | Pi 专用的 OpenAI 密钥 |
| PIGGY_COMPANION_NAME | 可选。在本环境私有配置中填写 Piggy 所代表的人的名字，重启 Pi 服务后生效 |
| PI_MODEL | 首次使用的模型，默认 gpt-6.2-sol；网页已保存的设置优先 |
| PIGGY_ADMIN_PASSWORD | 网页账号 piggy 的独立密码 |
| PIGGY_WORKER_TOKEN | Go 与 Pi 之间的随机内部密钥 |

安装并启动发布目录中的 piggy-pi 和 piggy-admin 两个 systemd 单元。按 `server/admin/nginx.conf.example` 配置本站证书和 HTTPS 8888。Go 不接收模型密钥，Pi 不接收网页密码。

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

将生成的 `android-bundle` 目录上传到目标环境，再调用该环境的发布器。以下示例用于日常测试发布。发布命令串行校验版本、签名摘要和文件哈希，完整写入 APK 后原子切换版本清单，服务运行期间即可发布。

```sh
/lighten012/projects/Piggy-staging/current/piggy-admin publish-android /path/to/android-bundle
```

版本清单和 APK 默认放在对应部署根目录的 `updates/android/`，独立于服务端代码版本；可通过 `PIGGY_UPDATES_DIR` 调整，发布命令与 systemd 服务需使用同一目录。迁移时复制此目录及原有聊天数据、配置，部署相同网关并保留原发布签名。迁移时沿用固定公网地址和端口；如将来确需更改地址，需在原地址发布配置了新地址的签名 APK。

按 CPU 发布时，默认准备 arm64-v8a 的 bundle，并将其余三个同版本、同签名的 bundle 放在其 `variants/<abi>/` 子目录，然后执行一次 publish-android。带 `?abi=<abi>` 的更新清单返回对应架构，旧手机客户端首次使用默认包后会检查本机架构。

从 0.12.1 起，发布命令自动定位 APK 内未再压缩的 `assets/office.lopack`，把其偏移、大小和 SHA-256 写入各架构的更新清单。若本机引擎一致，安卓通过两次 HTTP Range 请求读取该区间前后的内容，在缓存中还原并验证完整签名 APK。可跨版本升级。引擎不同、服务器不支持 Range 或还原校验失败时自动下载完整包。首次安装及从 0.12.0 升级仍使用完整包。代理须保留 Range 和 Content-Range 才能节省下载流量。
更新页按本次实际网络传输量显示进度、百分比和 MB；增量回退时切换到完整包的进度，下载后单独显示校验状态。
