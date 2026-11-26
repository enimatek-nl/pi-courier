# pi-courier

[English](README.md) | [简体中文](README.zh-CN.md)

通过 **绑定**换来的是独立进程、独立会话与默认目录 —— pi 的安全文档明说工作目录「不会阻止命令访问 Pi 进程能触达的其他路径」。**护栏**才让目录成为边界: 实例以 `-e <路径>/jail/guard.js --no-approve` 启动,`$HOME` 换成桥自己拥有、独立分配的目录(因此 jail 内的 `~/.ssh` 并不存在),而 pi 自身配置以只读例外挂入 —— 设置、skills 与 `AGENTS.md` 照常可用,但它无法安装宿主稍后会加载的扩展。此后每个工具调用都按解析后的路径判定(`~` 对 jail home、折叠 `..`、跟随符号链接),拒绝会记成 `[pi-courier jail] blocked read /etc/ssh/ssh_config: …`。它约束的是工具调用而非进程,所以它能挡住误操作、糊涂的客人和被注入的指令;要挡下怀有恶意的频道成员,答案是下一层:每个 jail 一个容器,只挂载该目录。完整规则、只读集合与限制所在:`docs/specs/channel-jail.md`。

### TUI ↔ Matrix 会话镜像(双端同步)

人在终端干活,bot 把一切同步到 Matrix。在房间里发:

```
/attach
```

bot 会回复一条可直接复制的终端命令,例如 `pi --session <会话ID>`(部署用了自定义会话目录时带 `--session-dir`)。在终端跑它附加同一会话,两端即保持同步:

- **TUI → Matrix(实时镜像)**:TUI 里你发的每条消息、agent 的每条回复都实时转发进房间——你的消息带 `🖥 **TUI·用户**` 前缀、agent 回复带 `🤖 **TUI·助手**` 前缀(消息都由 bot 账号发出,角色前缀是唯一区分);工具调用过程不转发,只同步对话文本。
- **Matrix → TUI(继承上下文)**:附加打开的就是同一个会话文件,TUI 启动即带着 Matrix 侧聊过的全部历史。
- **回到 Matrix(自动接力)**:TUI 干完活,直接回房间发消息——bot 会在空闲时先重载会话文件再作答,agent 的上下文自动包含 TUI 里发生的一切;进行中的任务与排队消息绝不会被重载打断。
- **TUI 侧 `/new`**:TUI 里开的新会话照常镜像,但房间会收到一条提示——Matrix 侧仍在原会话,两边上下文互不相通(不同的会话文件)。要让 Matrix 跟上:`/sessions` 后 `/switch <序号>`,或重新 `/attach` 获取新会话的命令;Matrix 侧 `/new` 之后同理,TUI 里重新 `/attach`。
- **分叉提示**:TUI 进程不会自动重读会话文件,Matrix 侧回复后你在 TUI 里续写,就会从旧节点接枝——bot 会提示一次并说明如何拉平(在 TUI 里 `/resume` 重进本会话即可接上 Matrix 侧的内容)。自动接力**不会**因此中断:它继续跟随会话文件里的最新分支。

`/detach` 关闭该房间的镜像。镜像按房间隔离、跟随房间自己的进程:项目房间镜像本项目的会话目录;走共享默认进程的房间镜像其会话目录并按工作目录过滤,其他项目的终端会话不会串进来。

### 服务管理

```bash
pi-courier status              # 状态 + 最近日志(可加项目名:pi-courier status <项目>)
pi-courier logs                # 跟踪日志(INFO 及以上)
pi-courier logs ai-api         # 多工程:只看该项目的打标日志
pi-courier logs ai-api www --level debug   # 多项目 + 全量细节
pi-courier logs --level debug  # 跟踪全部日志(含思考、流式增量)
pi-courier logs --level error  # 只看错误
pi-courier run --level debug   # 前台运行,全量显示
pi-courier restart             # 重启
pi-courier stop                # 停止
pi-courier start               # 启动
pi-courier disable             # 卸载服务
pi-courier update              # 更新 pi-courier 自身
pi-courier doctor              # 本地体检与健康报告(--fix 修安全项 / --json 机器可读 / --offline 跳过网络检查)
pi-courier verify              # 从外部视角看这个账号的加密状态(--json 机器可读)
pi-courier verify --bootstrap  # 给账号生成 cross-signing 身份并签自己那台(些)设备
pi-courier verify --sign [设备]  # 用包里的私钥给还缺签名的设备补签
pi-courier -v                  # 显示当前版本(--version/version 亦可)
```

日志级别:`debug < info < warn < error`。服务会把全部内容写入日志;`logs` 默认显示 INFO 及以上,`--level debug` 显示完整会话回放(用户消息、思考、工具调用、回复)。多工程模式下,项目相关日志行带有 `[项目名]` 标签,`logs <项目名>` 即可只看该工程(大小写不敏感;项目名 = `/pmctl` 的名称,未命名时为工作目录的目录名)。过滤经 `journalctl --grep` 实现,要求 journald 支持 PCRE2(Debian/Ubuntu 标准支持)。完整对话始终保存在 pi 的会话文件(`~/.pi/agent/sessions/`)。

### Doctor:一条命令的本地体检(与安全修复)

`pi-courier doctor` 用一次确定性的、离线友好的运行回答三个问题:这台机器上的 pi-courier 健康吗、哪里坏了、哪些可以安全地修。它不调模型、不主动碰网络、不拿锁、不启停服务 —— 体检动作对运行中的桥零干扰。

```bash
pi-courier doctor             # 只报告(默认;TTY 下修复前汇总问一次)
pi-courier doctor --fix       # 不问,直接修安全幂等项
pi-courier doctor --json      # 机器可读报告(同样脱敏;jq 可解析)
pi-courier doctor --offline   # 跳过全部网络检查(离线机器 / CI)
```

八组检查(每项带稳定 id 如 `B1`,人话与 JSON 报告都用它):

| 组 | 检查项 |
|---|---|
| A · 安装完整性 | 关键运行时文件(dist 入口、package.json、scripts、deploy),peer 包(`pi-ai`、`pi-coding-agent >=0.83`),版本一致(dist 错位即半更新),crypto 原生库 |
| B · pi 解析链 | 配置 `cliPath` 存在性(失效时报「配置里的 pi 路径失效」,可修:先备份后删除,桥回退自动发现),`which pi` → 托管布局解析,pi ↔ Node 引擎门,Node ↔ pi-courier `engines` |
| C · pi-courier 配置 | 文件存在/JSON 合法,关键字段类型,0600 权限,workdir 与 sessionDir 存在可写(全部 `projects`,一个坏项目不掩盖其他),proxy scheme |
| D · 状态与目录 | 自管目录(stateDir/dataDir)存在与 0700,陈旧单实例锁,人工停止标记,pending-update 残留,旧布局残留(只报告 + 迁移指引) |
| E · 网络(`--offline` 跳过) | Matrix whoami、homeserver 可达、代理可达 —— 每项 5 秒上限;超时是「查不出来」(⏭️),绝不误报成配置坏 |
| F · 服务(仅 Linux;Windows ⏭️) | systemd unit 存在/启用/运行,unit 钉的 node 与当前 `process.execPath` 对比(漂移 ⚠️)。只读:只发 `cat/is-enabled/is-active` 查询 —— 绝不写 unit、绝不启停 |
| G · 磁盘 | 剩余空间对运行时 ResourceGuard 同一 `diskHardMb` 阈值 |
| H · pi 侧(只读,禁区) | agent 目录解析,settings/auth/models JSON 合法性,至少一个凭据或默认模型 —— `--fix` 永不写 pi 目录下任何文件 |

退出码:`0` 健康或仅 ⚠️/⏭️(风险项不让 CI 失败),`1` 仍有 ❌,`2` doctor 自身崩溃。修复三档:**安全幂等**(`--fix` 自动做;改配置前先备份到 `<config>.doctor-backup`,修完打印 diff)、**提示**(只报告 + 下一步命令 —— workdir 缺失绝不代建)、**禁区**(永不碰:重新登录、重装 pi/Node、`trustedUsers`、删 session/数据、pi 的 auth/settings/models)。token/key 在两种输出形态里都最多露前 4 位。

**升级 pi** 是独立的事 —— pi-courier 始终通过 `which pi` 连接系统 pi:

```bash
npm install -g @earendil-works/pi-coding-agent@latest
pi-courier restart
```

pi.dev 托管安装(`~/.pi/agent`)同样支持:pi-courier 会把 `bin/pi` 包装脚本自动解析到当前版本的真实 JS 入口,pi 升级后无需改配置(0.3.1 起)。

### Verify:别人怎么看这个账号的加密

```bash
pi-courier verify           # 设备、谁签过它们、cross-signing 身份、本地密钥包
pi-courier verify --json    # 同一份报告,机器可读
```

一页只读事实,说的是桥登录的那个账号:有哪些设备、每台的签名者是谁、账号有没有发布
cross-signing 身份及其有效期、本地密钥包在不在且权限够不够紧。这里「已签名」指的是
被本账号的 self-signing key 签过 —— 正是客户端所谓「已验证」;设备自己的签名也会
显示,但每台设备都自签,所以它不算证据。它不写任何东西,也绝不打开 crypto store。
Element 那句「此会话未验证」需要一个可比对的身份;`verify` 告诉你有没有。

### 给桥一个 cross-signing 身份

```bash
pi-courier verify --bootstrap --dry-run   # 本地生成并自检密钥,什么都不上传
pi-courier verify --bootstrap             # 上传身份,并用它签桥自己那台(些)设备
```

这就是写的那一半,也是让警告消失的那一步:本地生成三把 Ed25519 密钥,master 签
self-signing 与 user-signing,三份一起上传(`POST /keys/device_signing/upload`,服务端只认 PUT
就用 PUT),
再用 self-signing key 去签本账号自己的设备文档(`POST /keys/signatures/upload`)。
私钥写到 `~/.local/state/pi-courier/cross-signing.json` —— 文件 0600,命令也会当面
提醒:请备份,丢了它就是丢了这份身份。

通常不需要密码:MSC3967 规定「首次」上传 cross-signing 密钥不要求 UIA,所以只有
这个 homeserver 主动要的时候才问 —— 走 `--password-file <路径>` 或终端隐藏输入,
用一次,绝不写进日志与返回值。也不需要设备亲自签一次:MSC1756 说 master key
「可以(may)」被设备签,而当前锁定的 crypto 绑定根本没有对外签名入口。

```bash
pi-courier verify --sign                 # 给所有还没签上的设备补签名
pi-courier verify --sign ABCDEFG1        # …或只签这一台
```

来了新设备(state 目录被清、换了 `XDG_STATE_HOME`)就用密钥包里那把 self-signing
key 去签,绝不另起一份身份:`--sign` 只读包里的私钥、补上缺的签名,签过的不碰。

`--device <id>` 只签指定那一台,默认签账号名下所有设备。本地已有密钥包时命令拒绝
运行(`--force` 可越过),账号已有 cross-signing 身份时也拒绝 —— 重置身份是件需要
想清楚的事,请在你平时做验证的客户端里做。emoji(SAS)验证在这层 crypto 上仍然
做不到:没有任何已发布的 Node 绑定会说 `m.key.verification.*`。这背后的实测都记在
`docs/specs/verify-device.md`。

### 进程挂了怎么办:systemd 与看门狗

systemd unit 自带 `Restart=on-failure` + `RestartSec=5`:进程**崩溃**(非零退出码或被信号杀死)后 5 秒自动拉起。崩溃守卫会把未捕获异常转成「留言 + 非零码优雅退出」,所以 JS 异常这类死亡也由 systemd 接住;`pi-courier stop` 是正常退出(退出码 0),不会被拉起。

systemd 管不了**僵死**:进程还在、PID 还在,但事件循环卡住不干活。unit 仍显示 active,journal 没有新日志,桥也不再回消息。补这个缺口的是独立看门狗 `deploy/watchdog/watchdog-posix.sh`:

- 每分钟由 cron / systemd timer 触发,读 `~/.local/state/pi-courier/heartbeat.json`(设了 `$XDG_STATE_HOME` 则在其 `pi-courier` 子目录下;桥每 30 秒原子写一次,同时记录磁盘与堆水位);
- 心跳超过 **180 秒**(= 6 × 30 秒;过期秒单点归属脚本常量,`--stale-seconds` 可覆盖)或心跳里的 PID 不存在 → `systemctl --user restart` 重启服务。PID 不存在时会先等 **2 × 心跳间隔**(默认 60 秒,`--heartbeat-interval-seconds` 可覆盖)再判死,覆盖 RestartSec 与首拍延迟,避免重启窗口里上一实例的旧心跳把正在启动的新实例再踢一次;
- 重启后用同目录的 `matrix-alert.mjs` 直读桥配置文件的 Matrix 凭据与管理房 ID(Linux:`~/.config/pi-courier/pi-courier.json`;`managementRooms[0]`,缺省回落 `space.roomId`),直接调 homeserver 的房间发送 API 发一条告警;冷却窗口默认 30 分钟(时间戳落在 `~/.local/state/pi-courier/watchdog-alert-stamp`),发送失败不落戳、下一分钟重试。告警不依赖桥进程 —— bot 死了告警照样出得去;
- 心跳文件不存在(桥还没跑过 first run)按安装错误处理:不告警、不动作。
- **人工停止不会被拉回**:`pi-courier stop` 会先写 `~/.local/state/pi-courier/watchdog-paused` 再调 systemctl(即使进程已经僵死、信号处理器跑不到,标记也能落盘),看门狗看到标记就跳过本轮判定;下次桥启动自动清除。`pi-courier restart` 由进程收到 SIGTERM 时写标记,随后新实例启动即清。直接 `systemctl stop`、`kill -9` 这类强杀不写标记,看门狗仍按失能拉起 —— 维护时请用 `pi-courier stop`,或先停看门狗。`pi-courier update` 在停服务前同样先写标记;升级中途失败时服务保持停止,修好后 `pi-courier start` 会清除标记并恢复。

安装(二选一,完整注释见脚本头):

```bash
# 方式一:cron(cron 环境通常没有 XDG_RUNTIME_DIR,不设会让 systemctl --user 报错;
# 把 1000 换成你的 uid,或直接用推荐的方式二)
* * * * * XDG_RUNTIME_DIR=/run/user/1000 /opt/pi-courier/deploy/watchdog/watchdog-posix.sh >> ~/.local/state/pi-courier/watchdog.log 2>&1
```

方式二:systemd timer(两个 unit 文件,`systemctl --user enable --now pi-courier-watchdog.timer`)。服务名默认 `pi-pi-courier`(与 `deploy/pi-courier.user.service` 安装后的名字一致),用 `PI_COURIER_SERVICE` 覆盖;`PI_COURIER_ALERT=off` 关闭告警,也可以设成自定义命令模板(含 `{message}` 占位,由看门狗做 shell 安全引用);`PI_COURIER_HEARTBEAT` 覆盖心跳路径。脚本按 **user unit** 写死 `systemctl --user`;若你用的是系统级 unit,请把脚本里的 `--user` 去掉并用 `PI_COURIER_SERVICE` 指定服务名。卸载:先停看门狗(`systemctl --user disable --now pi-courier-watchdog.timer` 并删除两个 unit 文件,或删掉 crontab 行),再 `pi-courier disable`;否则看门狗会在停止窗口过后把服务重新拉起。

**磁盘持续满盘的熔断**:桥在启动期、连接任何网络之前检查磁盘硬阈值(默认 512MB),低于即写一行死因日志退出、不发管理房留言。磁盘一直不清理时 systemd 会反复拉起,每轮只多一行本地日志。在 unit 的 `[Unit]` 段加熔断参数让它停手:

```ini
[Unit]
StartLimitIntervalSec=300
StartLimitBurst=5
```

(300 秒内启动 5 次即停止自动重启;清理磁盘后 `systemctl --user reset-failed pi-pi-courier` 再 `start`。)韧性参数都在配置文件的 `resilience` 段:心跳间隔默认 30 秒、磁盘软阈值 2048MB、硬阈值 512MB、堆告警 80%、pi RPC 连续拉起上限 5 次,改完重启生效。

**什么时候还需要看门狗**:要「僵死也能被拉起」「服务死了能收到 Matrix 告警」就装;只靠 systemd 的崩溃拉起、接受「僵死要人工发现」可以不装。看门狗的过期秒刻意不进桥的 `resilience` 配置 —— 它零桥代码依赖,只读心跳与 Matrix 凭据;桥改 `resilience.heartbeatIntervalSeconds` 时,同步调整脚本默认值(或安装参数),保持 6 倍关系。

## Windows

自 1.0.0 起正式支持,并已于 2026-10-14 在真实 Windows Server 2025 机器上端到端验收:安装(原生库下载 + sha256 校验 + 加载)、配置向导、Matrix 连接、`!`/`!!` bash、单实例锁、多工程房间与空间组织、任务计划程序自启、Ctrl+C 干净退出。除下文明确列出的限制外,行为与 Linux 一致。

**系统要求**:

- Node.js >= 22.19(与 pi 1.x 的硬性下限一致)
- **Git for Windows** —— `!` / `!!` 命令由它自带的 bash 执行;没装的话会得到一条可读的报错
- pi,全局安装 —— 发现方式见下

E2EE 加密原生库对 `win32-x64-msvc` / `win32-ia32-msvc` / `win32-arm64-msvc` 提供预编译产物,安装时下载并做 sha256 校验(x64 已真机验证:`.node` 落在 `~/.cache/pi-courier/native-crypto/`,经 N-API 正常加载)。

**安装与运行**:

```powershell
npm install -g pi-courier
pi-courier setup
pi-courier run
```

npm >= 11 开了 install-scripts 门禁的机器(会出现 `npm warn install-scripts` 警告)会静默跳过 postinstall——包括原生库自检;带白名单装一次:

```powershell
npm install -g --allow-scripts=pi-courier,@matrix-org/matrix-sdk-crypto-nodejs pi-courier
```

验证:`pi-courier -v`。npm 装到 `%APPDATA%\npm` 的 `.cmd` / `.ps1` 垫片照常可用。

- **pi 自动发现**:npm 全局安装的 `@earendil-works/pi-coding-agent` 会从 pi-courier 自身的安装树自动解析命中;pi.dev `install.ps1` 装在 `~/.pi/agent` 的同样自动识别。只有特殊布局才需要把 `PI_CLI_PATH` 指到 pi 包目录里的 `dist/cli.js`——**不要**指 `pi.cmd` / `pi.ps1` 垫片。
- **`!` / `!!` bash 命令走 Git for Windows 的 bash** —— POSIX 路径(`/c/Users/...`)、退出码、报错信息都与 Linux 一致地透传。Windows 风格路径要按 bash 规则写:未加引号的 `d:\share\Projects` 里的反斜杠会被当转义符吃掉,请写 `/d/share/Projects` 或加引号 `'d:\share\Projects'`;踩了这个坑(命令失败且含未加引号的 `X:\` 路径)时,回帖末尾会自动附一行写法提示。
- **`pi-courier update` 在 Windows 上可用**:它通过 npm 的 `npm-cli.js` 入口启动 npm,并跳过 systemd 的停启编排。
- **任务计划程序自启**(无需管理员,每次登录触发)——真机验证过的配方:

  ```powershell
  $action  = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "//nologo `"$env:APPDATA\npm\node_modules\pi-courier\deploy\windows\run-hidden.vbs`""
  $trigger = New-ScheduledTaskTrigger -AtLogOn
  Register-ScheduledTask -TaskName 'pi-courier' -Action $action -Trigger $trigger
  Start-ScheduledTask -TaskName 'pi-courier'   # 立即启动;此后每次登录自动拉起
  ```

  启动器(`run-hidden.vbs`,随包发布)以**隐藏控制台**(窗口样式 0)拉起桥并自建日志目录——桌面不再有常驻黑窗。它刻意保留**交互会话**:agent 拉起的 GUI 进程(浏览器、UAC 弹窗、桌面自动化)照常出现在你的桌面上,这也是桥任务**不要**改用 S4U/session 0 的原因。

  这是**登录触发型**任务:只在每次登录时拉起。进程中途崩溃、被杀死或僵死,任务都不会重新拉起;进程死掉后任务状态还可能停留在 Running。补自愈有两条路线:

  - **auto-logon(自动登录桌面)**:让机器重启后自动登录,计划任务随之触发。代价是凭据与桌面会话留在无人值守的机器上(安全风险);而且它只解决「重启后没人登录」,仍然发现不了进程僵死。
  - **看门狗(推荐)**:独立计划任务每分钟运行 `deploy/watchdog/watchdog-windows.ps1`,读 `%APPDATA%\pi-courier\state\heartbeat.json`。心跳超过 **180 秒**(= 6 × 30 秒,`-StaleSeconds` 可覆盖)或心跳里的 PID 不存在(PID 消失同样等 2 × 心跳间隔,默认 60 秒)→ ① PID 仍存活(僵死)时先 `taskkill /F /PID` 杀旧实例(单实例锁不抢占活进程,不先杀新实例会秒退);② `schtasks /end` 终止卡住的任务实例(end 失败不阻断下一步);③ `schtasks /run` 拉起。随后用同目录的 `matrix-alert.mjs` 直读 `%USERPROFILE%\.pi\pi-courier.json` 的凭据与管理房,发一条 Matrix 告警(默认 30 分钟冷却)。心跳文件不存在按安装错误处理:不告警、不动作。看门狗自身需要 `node` 在 PATH 上。

    安装(桥的任务名默认 `pi-courier`,与上面的配方一致;把脚本路径换成你的实际安装目录,npm 全局安装通常在 `%APPDATA%\npm\node_modules\pi-courier\deploy\watchdog\`)。PowerShell 一次性注册,与桥任务同用户上下文、无需管理员;`Register-ScheduledTask` 按原生参数传值,`-Argument` 里用内嵌双引号包住脚本路径,含空格的安装路径也安全。旧 `schtasks /create ... /tr` 拼引号写法已废弃,不要再抄:

    ```powershell
    $action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "//nologo `"$env:APPDATA\npm\node_modules\pi-courier\deploy\windows\watchdog-run-hidden.vbs`""
    $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 1) -RepetitionDuration (New-TimeSpan -Days 3650)
    Register-ScheduledTask -TaskName "pi-courier-watchdog" -Action $action -Trigger $trigger -Force
    ```

    壳脚本(`watchdog-run-hidden.vbs`,随包发布)隐藏每分钟的控制台闪窗,同时保留交互会话。若可提权,`LogonType S4U` 是备选(无登录也能无头运行)——非提权 PowerShell 直接注册 S4U 会被拒绝访问(2026-11-03 真机实测)。

    (`-RepetitionInterval` + `-RepetitionDuration ([TimeSpan]::MaxValue)` 等价旧 `schtasks /sc minute /mo 1`:每分钟触发、无限重复。任务名请保持不带空格 —— 看门狗重启序列会以不带引号的形式调 `schtasks /end` / `/run`。)

    参数:`-TaskName` 桥的计划任务名;`-HeartbeatPath` 心跳文件(默认 `%APPDATA%\pi-courier\state\heartbeat.json`);`-StaleSeconds` 过期秒(默认 180 = 6 × 30,换算关系见脚本头注释);`-HeartbeatIntervalSeconds` 心跳间隔秒(默认 30,PID 消失后的宽限期 = 2 × 该值);`-NoAlert` 关闭 Matrix 告警。用 Ctrl+C / Ctrl+Break 正常退出会写人工停止标记,看门狗不会把服务拉回(`pi-courier stop` 仅 Linux 可用);`schtasks /end` 属强杀、不写标记,维护或卸载前请先停看门狗任务。卸载:

    ```powershell
    Unregister-ScheduledTask -TaskName "pi-courier-watchdog" -Confirm:$false
    ```

    先删看门狗任务,再停桥/删桥任务 —— 否则看门狗会在停止窗口过后把桥重新拉起。

  [NSSM](https://nssm.cc/) 之类的 Windows 服务包装器能省掉登录依赖,但要把 Node 变成系统服务,安装、升级、日志都更重;本版本不提供实现,只作为权衡选项保留。或者干脆保持前台会话。
- **Ctrl+C / Ctrl+Break(SIGBREAK)干净退出** —— pi RPC 停止、Matrix 断开、单实例锁释放。
- **单实例锁**行为一致:崩溃残留的锁会被下次启动自动接管,无论从控制台还是任务计划程序启动。
- 配置文件权限检查(0600)在 Windows 上跳过:系统无法表达 POSIX 权限位,继续检查只会每次启动误报。

**已知限制**:服务管理子命令(`enable` / `start` / `stop` / `restart` / `status` / `logs` / `disable`)仅支持 Linux(systemd),在其他平台会直接报错退出;`pi-courier logs` 的过滤依赖 journald(Linux)。配置(`pi-courier.json`)与 pi 自身会话(`agent/sessions`)仍在 `%USERPROFILE%\.pi\` 下;附件、数据与运行状态在 `%APPDATA%\pi-courier\`(运行状态在其 `state\` 子目录)。

## 4. 常见问题

**Q: `npm install` 卡住 / 只有 20-60 kB/s?**
A: 21 MB 的 E2EE 原生库从 GitHub Releases 下载,不走 npm 代理。先 `export https_proxy=... http_proxy=...`(写进 `~/.bashrc` 永久生效)再装。

**Q: 报 `Cannot find module '@matrix-org/matrix-sdk-crypto-nodejs-…'`(任意平台后缀)?**
A: 原生二进制没下载——postinstall 被拦。npm ≥ 11 开了 install-scripts 门禁的机器上这是**静默**的;带白名单重装一次 `npm install -g --allow-scripts=pi-courier,@matrix-org/matrix-sdk-crypto-nodejs pi-courier`。源码方式则手动补:`cd node_modules/@matrix-org/matrix-sdk-crypto-nodejs && node download-lib.js`。

**Q: `npm install -g pi-courier` 报 EEXIST?**
A: 之前 `npm link` 过,bin 冲突。`npm unlink -g pi-courier && rm -f $(npm prefix -g)/bin/pi-courier && npm install -g pi-courier`。

**Q: 装完了,但 `pi-courier: command not found`?**
A: 多半是用了 pi.dev 包页面给的 `pi install npm:pi-courier`。那条命令是把 pi-courier 装成 pi 扩展(pi 里多一个 `/pi-courier` 用法提示),不是装 CLI。用 `npm install -g pi-courier` 装 CLI,顺手可用 `pi remove npm:pi-courier` 清掉误装的扩展。

**Q: systemd 服务反复重启?**
A: 几乎都是 Node 版本不匹配 —— pi 子进程在系统 node v20 上崩溃(报 `webidl.util.markAsUncloneable is not a function`)。加载 nvm 后重新 `pi-courier enable`(0.1.2+ 会自动写入正确的 PATH)。全机统一一个 Node 版本。

**Q: 启动显示 `model: unknown`?**
A: pi 的 provider 没配。检查 `~/.pi/agent/`:`models.json` + `auth.json` + `settings.json`(字段名是 `defaultProvider` / `defaultModel`)。

**Q: 日志大量 `Decryption error`?**
A: 历史消息无法解密(新设备没有旧密钥)。**正常**,新消息不受影响。

**Q: 加密房间:发消息没回复 / 新消息解不开?**
A: bot 的新设备没拿到房间密钥。bot 账号没有交叉签名,最可靠的解法是**用非加密房间**(新建房间时不勾选加密,把 bot 拉进来)—— 配置 `encryption: true` 也照常处理非加密房间。

**Q: 报 `M_BAD_JSON: Provided device_id in device_keys does not match...`?**
A: 本地加密存储与 token 的设备身份不一致(换过 token / 粘贴了别的设备的 token)。**0.1.20 起用密码登录走固定 device_id,重跑 setup 不再出现此问题**。仍遇到时:删除加密存储重启 `rm -rf ~/.local/share/pi-courier/matrix-crypto && pi-courier restart`(Windows:删 `%APPDATA%\pi-courier\matrix-crypto`)(每次重跑 setup / 换 token 都顺手删一次)。

**Q: 报 `One time key signed_curve25519:... already exists`(M_UNKNOWN)?**
A: token 在服务器上已绑定旧设备,但本地与服务器的 OTK 记账错位 —— **删本地 crypto store 无效**(device ID 由服务器按 token 指定,删了重建还是同一个)。**必须换 token**:重跑 `pi-courier setup`,在"保留现有 token?"处输 `n` 重新获取(或直接密码登录),新 token = 新设备 = 服务器干净。换 token 后如遇 device 残留问题再配合删 crypto store。

**Q: 第一次发消息要 6 位验证码?**
A: 这是挑战认证 —— 把验证码回复给 bot 即成为 trusted user。

**Q: 消息完全没有回复?**
A: 按顺序排查:(1) `pi-courier status` —— Matrix 连上了吗?有 Decryption error 吗(加密房间)?(2) pi RPC 连上了吗?(3) 模型调用本身 —— 用 curl 直接测 provider 端点。

**Q: `pi RPC did not become ready`?**
A: pi 启动失败。手动跑 `node node_modules/@earendil-works/pi-coding-agent/dist/cli.js --mode rpc` 看真实报错。常见原因:Node 版本不匹配、provider 配置错误、无法访问 provider。

**Q: 重启后对话上下文丢了?**
A: 0.1.1 起 bridge 会给 pi 传 `--continue`,按 workdir 恢复最近会话。升级并重启即可;`/new` 开新会话,下次重启恢复新会话。

**Q: Element(网页客户端)拦截 `/` 开头的消息?**
A: 用 `//` 转义发送字面文本(如 `//compact` 会发出 `/compact`)。

**Q: 配置文件里到底有什么?**(Linux:`~/.config/pi-courier/pi-courier.json`;Windows:`%USERPROFILE%\.pi\pi-courier.json`)
A: 向导生成的配置,示例:

```json
{
  "matrix": { "homeserverUrl": "https://matrix.example.com", "accessToken": "syt_...", "encryption": true },
  "auth": { "trustedUsers": ["matrix:@你:matrix.example.com"], "adminUserId": "matrix:@你:matrix.example.com" },
  "workdir": "/home/你/Projects",
  "multiProject": true,
  "space": { "enabled": true },
  "autoConnect": true,
  "debug": true
}
```

环境变量替代(优先级:环境变量 > 配置文件 > 向导):

| 变量 | 对应字段 |
|---|---|
| `PI_MATRIX_HOMESERVER` + `PI_MATRIX_ACCESS_TOKEN` | matrix.homeserverUrl / accessToken(两者同时设置才生效) |
| `PI_MATRIX_ENCRYPTION` | matrix.encryption(`true`/`false`) |
| `PI_MATRIX_TRUSTED_USERS` | auth.trustedUsers(逗号分隔 MXID,如 `@barry:matrix.example.com`) |
| `PI_WORKDIR` | workdir |
| `PI_LOG_LEVEL` | logLevel(debug/info/warn/error) |

LLM key 也可用环境变量:auth.json 里写 `"key": "${PI_LLM_API_KEY}"`,pi 启动时从环境变量读取(Docker 部署的模板已默认如此)。

## 5. 协议与声明

MIT License —— 见 [LICENSE](LICENSE)。

**上游来源**:本项目改造自 [tintinweb/pi-messenger-bridge](https://github.com/tintinweb/pi-messenger-bridge)(MIT)。Matrix 传输层与挑战码认证来自上游;基于 RPC 的独立架构、slash 命令映射、CLI、配置向导与文档为本项目新增。

pi-courier 是 [pi](https://pi.dev) 的独立伴侣应用,与 Earendil Inc. 无隶属关系。
