# Spec:已读回执(bridge 把消息标成已读)

> issue: 本仓库自有需求(上游无对应票面)。同族体验票:typing 心跳(spec #363)
> 与终答点名(spec #364)—— 三张合起来才是「远程会话里我到底知不知道发生了什么」。

## 问题陈述(Problem Statement)

安静模式的桥只剩两个信号:回合开始时那行「正在输入……」,以及终答。
发送方那边看到的是——自己那条消息**永远停在「未读」**,而旁边 pico 正在输入。
这两件事同时出现却不互相解释:客户端的「已读/seen」由 MSC2228 的 `m.receipt`
决定,桥以前从不发它,于是房间里的读序一直不动。

Matrix 的读回执不是事件而是一条 EDU(`PUT /rooms/{roomId}/readreceipt/m.read/
{eventId}`),它把「本房读序」标到某条事件为止,发送方的客户端因此能把那条
(及其之前所有)消息显示成已读。SDK 0.8.0 已有 `sendReadReceipt(roomId, eventId)`,
桥只是从来没调过。

## 解决方案(Solution)

1. 端口加 `sendReadReceipt`,transport 暴露尽力而为的 `markRead(chatId, messageId)`;
   合成根把它接成 router 的可选依赖。
2. 桥**受理**一条消息时把本房读序标到那条事件 —— 受理 = 过了授权门
   (`ChallengeAuth.checkAuthorization` 返回 true),也就是「桥确实要处理它」。
3. 新增全局偏好 `readReceipts`,**缺省开**;管理命令 `/togglereads` 翻转并回执
   `👁 Read receipts: on|off`。

## 用户故事(User Stories)

1. 作为发完消息就走开的人,我希望手机上的对勾变成「已读」,这样不用回到房间
   也知道桥接住了这条。
2. 作为把桥拉进多人房间的人,我希望它只标它真的受理的消息 —— 群里被模式门
   挡下的那些不该显示成被读过。
3. 作为不想让机器人暴露在线活动的人,我希望一条命令关掉回执。
4. 作为运维,我希望回执失败绝不影响回复 —— 它不是任何消息的前置条件。
5. 作为维护者,我希望关掉开关时出站形状与这个功能出现之前逐字节一致。

## 实现决策(Implementation Decisions)

- **落点在授权门之后、且只在它之后**:`authorization` 阶段的 `handle` 里
  `ctx.isAuthorized === true` 才发。这条判据就是「桥接下来真的要看这条」——
  群聊里被 `mentions` / `mentions-trusted` / `trusted-only` 挡下的消息不发,
  因为那确实是「没读」;访客被命令面拦下的消息照发(消息本身被读了,拦的
  是那条命令)。
- **顺序上先回执、再干活**:回执是一次独立 HTTP,排在 pi 的 prompt 之前发出,
  所以「已读」不会比它描述的那条消息来得晚。
- **不进 per-room 发送 FIFO**:`sendMessage`/`editMessage` 走队列保证房间时间线
  顺序;回执不是时间线里的东西,排在一条长队后面只会让它迟到。直接打端口。
- **尽力而为的三层静默**:未连接或没有 event id → 直接返回;SDK 抛错 →
  debug 日志;router 侧再兜一层 `catch` —— 回执永远不是回复的前置条件,
  与 typing 同款契约(`sendTyping` 也是吞掉一切错误)。
- **缺省开**:这不是新增噪音(回执不产生通知、不刷屏,客户端只是把一个对勾
  画成已读),而关掉它才是「明明在线读过却装作没看到」。配置里显式
  `readReceipts: false` 即回到旧行为。
- **`/togglereads` 传生效值**:配置里没写过这一项 = 开,所以命令面拿到的
  是 `store.get().readReceipts !== false` 而不是原始字段 —— 否则新鲜配置上
  第一次翻转会从「未写·开」翻成「显式·开」,看起来像命令没反应。
- **端口结构型对齐 SDK**:`MatrixClientPort.sendReadReceipt(roomId, eventId)`
  与 matrix-bot-sdk 0.8.0 的同名方法一致,不新增适配器代码;测试夹具
  (`matrix-fakes.ts`)补一个同名 recorder。
- **不做已读标记(m.fully_read / read marker)**:那是「我读到这里」的私用
  书签,客户端显示不同、语义更弱;本票只要 `m.read` 回执。

## 测试决策(Testing Decisions)

- `tests/matrix-provider.test.ts`:`markRead` 把 `(roomId, eventId)` 原样送到端口;
  未连接时一个客户端都不会被创建;空 event id 不发;端口抛错时 `markRead`
  不抛。
- `tests/router-projects.test.ts`:夹具多一条 `markRead` 缝与 `marks` 表 ——
  私聊授权消息恰一次回执(chatId + messageId);群里陌生人点名(模式门拦下)
  **零**回执;`readReceipts: false` 零回执。
- `tests/auth-engine.test.ts`:`/togglereads` 以效果回传翻转值、回执带 👁;
  两次翻转回到原值 —— 与 `/toggletools` `/togglefooter` `/togglemention` 同钉法。
- `tests/guest-policy.test.ts`:访客禁列表加 `/togglereads`。

## 影响面与不变项(Out of scope)

- 不改消息管道与授权语义:回执是授权结果的**读者**,不是它的一部分;
  门挡下什么、访客能碰什么一律不变。
- 不做逐条消息的「已读但没处理」细分(比如附件下载完成后才标读):读回执的
  语义就是「看到了」,不是「办完了」。
- 不做已读标记(`m.fully_read`)、不做 threaded receipt(MSC2285 线程维度)。
- 非 Matrix 传输没有这条能力:依赖是可选的,没注入就没有回执,其余照旧。
- 关掉开关不影响服务器端已有的读序 —— 那是历史事实,桥只是不再更新它。
