# Spec #364:终答点名提问者(/togglemention 与 mentionAsker)

> issue: 本仓库自有需求(上游无对应票面)

## 问题陈述(Problem Statement)

远程会话是「安静」的:`/toggletools` 收起了工具流,`/togglefooter` 收起了状态
脚注,回合进行中只有一行「正在输入」。这些都有代价 —— **房间里的提问者在
自己不在屏幕前时,没有任何理由被拉回来**。群里更是如此:桥的回复是一条普通
新消息,Matrix 的推送规则看的是事件里的 MSC3089 `m.mentions` 字段,正文里
出现 `@某人` 并不构成通知依据(spec #363 读侧已经承认过同一事实:客户端的
点名牌只写 `content["m.mentions"].user_ids`,纯文本匹配会漏)。

多工程关掉时更明显:多个房间共用一个 pi 会话,回复本身不说是答给谁的;
谁问的、答给谁,只有翻聊天记录才知道。

## 解决方案(Solution)

1. 新增全局偏好 `mentionAsker`(配置字段,**缺省关**):开启后每条终答的
   首片行首附上提问者的 `@user:server`,并带 MSC3089
   `content["m.mentions"].user_ids` —— 正文里的那一半是给人看的,结构化字段
   那一半才是客户端发通知的依据。
2. 新增管理命令 `/togglemention`(DM,信任用户),翻转该偏好并回执
   `📣 Mentioning the asker at the top of final answers: on|off`。
3. `/help` 管理命令清单(en/zh)、README(双语)、访客禁列表同步登记。

## 用户故事(User Stories)

1. 作为把手机通知关到只剩 @ 的桥用户,我希望终答点名我,这样任务跑完我会被
   拉回房间,而不是两小时后才想起来看一眼。
2. 作为多人协作房里的被 @ 者,我希望点名的是**本回合的提问者**,而不是上一条
   消息的人或多工程默认会话里最新的那个说话的人。
3. 作为受不了重复打扰的用户,我希望一条长回复只点一次名 —— 分片成三条消息
   时不要给我三条通知。
4. 作为工具循环跑二十步的任务发起者,我希望中间那些步骤消息不点名,否则点名
   就退化成刷屏。
5. 作为访客,我希望碰不了这个开关(它决定别人什么时候被通知)。
6. 作为维护者,我希望关掉开关时终答与「点名功能出现之前」逐字节一致,连出站
   选项都不递。

## 实现决策(Implementation Decisions)

- **点名只有一处落点**:终答出站走 `message-router` 的 `dispatch()`(工具循环
  中间回合走活卡链路,不经过这里)。与状态脚注同一个函数、同一句
  `!turn.pendingTools` 判据 —— 中间消息既不挂脚注也不点名。
- **点名随首片,脚注仍随末片**:脚注是「这条回复的落款」,末片最合适;点名是
  「这条回复说给谁」,读起来应该在开头。`m.mentions` 只附在正文里带 MXID 的
  那**一件事件**上:推送按事件计,附两件就是两条通知。
- **就地编辑的活卡永远不点名**:MSC2676 的编辑事件不产生新事件推送,而且一张
  持续刷新的工具卡每次编辑都点名等于每步通知一次。`editMessage` 因此不接
  `SendOptions`。
- **出站签名加一个可选末位参数**:`sendReply(chatId, transport, text, opts?)`
  与 `MatrixProvider.sendMessage(chatId, text, opts?)`。`SendOptions` 目前只有
  `mentionUserIds` 一项。其余调用点(命令回执、告警、欢迎卡)一律不传 —— 它们
  连参数个数都没变,`router` 各 dep 类型里没写 `opts` 的也照常通过结构类型赋值。
- **点名身份是原始 MXID**:`ReplyTarget.userId` 取 `ExternalMessage.userId`
  (= 事件 `sender`),不带认证层的 `matrix:` 前缀;`m.mentions.user_ids` 规范
  上收的就是用户 ID。
- **名单先过守门**:`sanitizeMentionUserIds` 只放行 `@localpart:server` 形状
  的串。脏值让服务器整条消息吃 `M_INVALID_PARAM` 比少点一个名严重得多,所以
  宁可静默丢掉不合法的条目。
- **命令走既有 adminCommands 阶段**,纯模块 `handleAdminCommand` 只回传效果
  `{ kind: "mentionAsker", value }`,落盘归调用方 `store.update` —— 与
  `/toggletools`、`/togglefooter` 同一 read-then-flip 契约。注意本字段是**正**
  语义(`true` = 点名),与那两个 `hide*` 相反:开关的名字是「点名」,回执就
  该说「点名:开」。

## 测试决策(Testing decisions)

- `tests/auth-engine.test.ts`:`/togglemention` 以效果回传翻转值(不碰存储)、
  回执带 📣(键缺失会输出键名)、两次翻转回到原值 —— 与 `/togglefooter` 同钉法。
- `tests/router-projects.test.ts`:夹具的 `replies` 多记一笔 `mentionUserIds`
  (正文与出站选项分开断言)。开:`4500` 字硬切两片时,首片 `startsWith("@barry:server\n")`
  且带 `["…"]`,次片不带;关:`toBe("all done")` 且选项根本没递。
- `tests/matrix-provider.test.ts`:出站事件不点名时连 `m.mentions` 键都不存在;
  点名时值为 `{ user_ids: [...] }`;`["alice", "", "@ok:server"]` 只剩合法那一条。
- `tests/guest-policy.test.ts`:访客禁列表加 `/togglemention`(表是单一声明点)。

## 影响面与不变项(Out of scope)

- 不做房间级覆盖:点名的是「本回合提问者」这件事本身已经逐回合,逐房开关
  没有额外意义(与 `/togglefooter` 同理)。
- 不做 thread 回复(`m.relates_to` in_reply_to)与 pill 富文本(matrix.to 锚点):
  点名要的是通知,不是排版。Element/FluffyChat 对正文里的 MXID 自己渲染点名牌。
- 不改入站点名判定(spec #363 的 `m.mentions` 读侧)、不改 `/mentions-trusted`
  模式、不改活卡聚合与状态脚注的取数口径。
- 非 Matrix 传输今天没有 `m.mentions` 这个概念,也就拿不到 `userId` 之外的
  点名语义:没有身份就没有点名,`sendReply` 的选项到 transport 为止被忽略。
- 历史消息不受影响 —— 点的是出站,不是回填。
