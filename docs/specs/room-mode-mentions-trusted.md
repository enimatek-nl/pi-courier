# Spec:房间模式 mentions-trusted(点名 ∩ 信任)

> issue: 本仓库自有需求(上游无对应票面)。姊妹票:spec #364(终答点名提问者)
> —— 那张管出站点名,这张管入站点名判定。

## 问题陈述(Problem Statement)

桥能在额外频道里被拉进去干活,但**四档房间模式是一道单选**(types.ts 的
`ChannelMode`),而真实需求是两个条件的交集:

- `mentions`:任何成员 @ 一下就动。共享频道里这意味着**谁都能拨动这个桥** ——
  单工程部署下所有房间共用一个 pi 会话,陌生人的一条 @ 就是一次真模型调用,
  还会把回复发进同一个上下文。
- `trusted-only`:信任成员不用 @ 也动。这在自己人的房间里对,在几十人的公开
  频道里等于把信任用户变成频道内的常驻机器人 —— 他们随口一句也被接走。

缺的就是中间那一档:**既被点名、又来自信任成员**。

顺带一个入站漏洞:点名判定此前只做文本匹配(`@bot`、`@bot:server`),而
Element/FluffyChat 的 @ 点名牌(pill)在 `content.body` 里往往**只写展示名**,
真正的点名藏在 MSC3089 的 `content["m.mentions"].user_ids`。也就是说客户端里
「点了名字」这种最标准的点名方式,靠文本匹配是认不出来的。

## 解决方案(Solution)

1. 新增房间模式 `mentions-trusted`:**点名 ∩ 信任**,即 `mentions` 与
   `trusted-only` 的交集。陌生人 ping 不动桥,自己人也要 @ 才动。
2. 点名判定同时读 MSC3089 的 `m.mentions.user_ids`:文本写不写 MXID 都算点到。
3. `/enable <chatId> <模式>` 的用法行、setup 向导的模式清单、README(双语)
   模式表同步加一档。

## 用户故事(User Stories)

1. 作为把桥拉进公开频道的人,我希望只有我 @ 它才回应,频道里别人的 @ 不消耗
   我的模型额度。
2. 作为频道里的信任成员,我希望 @ 一下就有人干活,不必因为我是信任用户就
   每句话都被接走。
3. 作为在 Element 里点名字而不是手打 MXID 的用户,我希望点名牌和手打等价。
4. 作为信任用户(不是管理员),我希望自己能给某个房间打开这一档 —— 只有
   `all`(全房间任何人)才是管理员专属。
5. 作为维护者,我希望模式登记只有一处,新增一档不会漏改某条调用路径。

## 实现决策(Implementation Decisions)

- **`CHANNEL_MODES` 是模式的唯一登记表,`parseChannelMode` 是唯一解析点**
  (`src/auth/challenge-auth.ts`):`/enable` 的两条路径、setup 向导、配置里的
  存储形式都从这里取,新增一档只改一处;不是登记词的一律返 `undefined`,
  调用方回用法行。大小写敏感 —— 模式串同时是配置文件里的存储形式。
- **判定落点仍是 `shouldRespondByMode` 单一 switch**:`mentions-trusted` 就一行
  `wasMentioned && trustedUsers.has(...)`。它与 `trusted-only` 的唯一差别就是
  这道点名门,与 `mentions` 的唯一差别就是这道信任门。
- **谁能开**:`/enable` 只把 `all` 留给管理员(`mode === "all" && !isAdmin` 才拦),
  所以 `mentions-trusted` 信任用户即可开启 —— 它是收紧,不是放宽。
- **点名 = 文本或结构化标记**(`wasBotMentioned(text) || contentMentionsBot(content)`):
  只在群聊分支上计算(私聊本就不走点名门);`contentMentionsBot` 对形状宽容 ——
  缺字段 / 非数组 / 非字符串元素一律当「没点名」,绝不抛。命中后仍走
  `stripBotMention` 剥掉文本形式的 @,和旧行为对称。
- **不改的东西**:信任名单本身、访客档(guest policy)、房间启用/禁用、
  `mentions` 与 `trusted-only` 的既有语义,全部逐字节不变;新档只是多一个
  switch 分支。

## 测试决策(Testing Decisions)

- `tests/auth-engine.test.ts`:`mentions-trusted 要求点名与信任两个条件同时成立`
  —— 同一句「@ 了但陌生人」在 `mentions` 放行、在这一档拦下;「信任但没 @」在
  `trusted-only` 放行、在这一档拦下。另钉 `/enable <房> mentions-trusted` 被接受
  且回执带上模式名,未知模式仍回用法行。
- `tests/matrix-events.test.ts`:点名牌等价 —— body 只写展示名而
  `m.mentions.user_ids` 含 bot 时算点名;只点别人不算;私聊不写
  `wasMentioned`(私聊不走点名门)。
- `tests/router-projects.test.ts`:端到端一道门 —— 群里 `/enable mentions-trusted`
  之后,陌生人 @ 的消息不进管道,信任成员 @ 的进。

## 影响面与不变项(Out of scope)

- **不做「点名即免信任」之外的第三态**:比如「点名且是访客则只回一句提示」 ——
  访客面已有独立裁决(`guest-policy`),不在模式里再分叉。
- 不改多工程的会话归属:单工程部署下所有房间共用默认 pi 会话,回复跟的是
  **本回合提问者**(reply binding),模式门只管「进不进得来」。真正按房隔离
  走 `/pmctl` 项目房。
- 不做出站点名(那是 spec #364)、不做 `m.mentions` 的 room_prepend 一类
  扩展字段。
- 已启用房间的配置值不变:老配置里没有 `mentions-trusted` 就一切照旧。
