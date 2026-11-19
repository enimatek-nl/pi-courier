# Spec #362:状态脚注开关(/togglefooter 与 hideStatusFooter)

> issue: 本仓库自有需求(上游无对应票面)

## 问题陈述(Problem Statement)

回复末尾的状态脚注(spec #344)默认恒开:每条终答下方都追加一行
`📂 工作目录 · 📜 上下文占用 · 🤖 模型·思考等级`。工具调用的显示有
`/toggletools`(hideToolCalls)可关,脚注却没有对应开关 —— 想要「只有回复正文」
的用户只能逐条忍受,或在客户端里自己划掉。同样缺的是一个显示层的
总开关面:`/help` 的管理命令清单里,只有工具流一行可关。

## 解决方案(Solution)

1. 新增全局显示偏好 `hideStatusFooter`(配置字段,缺省 = 未隐藏),与
   `hideToolCalls` 同族同契约:纯显示层、落盘、重启后仍在。
2. 新增管理命令 `/togglefooter`(DM,信任用户),翻转该偏好并回执
   `📝 Status footer hidden|shown`。
3. `/help` 管理命令清单(en/zh)与 README(双语)同步登记;访客照旧被
   command-registry 硬拦(`guest: "blocked"`)。

## 用户故事(User Stories)

1. 作为只要回复正文的桥用户,我希望一条命令关掉脚注,这样终答不再带路径与
   上下文占用行。
2. 作为排查上下文占用的用户,我希望随时再打开它,这样需要看模型/窗口时不用改配置重启。
3. 作为把偏好写进配置文件的使用者,我希望 `hideStatusFooter: true` 在启动即生效。
4. 作为访客,我希望碰不了这个开关(它改变所有人看到的回复形状),回执是礼貌的权限提示。
5. 作为维护者,我希望关闭态与「脚注功能出现之前」逐字节一致,不留第二种终答形状。

## 实现决策(Implementation Decisions)

- 开关只作用于**终答出站拼接**这一处:`message-router` 的 dispatch 里
  `!turn.pendingTools && !store.get().hideStatusFooter` 才取数拼接。关时连
  `collectStatusFooter` 的两次 stdio RPC 往返都不发生(spec #344 取数本就现拉现用)。
- 命令走既有 adminCommands 阶段(DM、信任用户),与 `/toggletools` 的 DM 半边同路;
  纯模块 `handleAdminCommand` 只回传效果 `{ kind: "hideStatusFooter", value }`,
  落盘归调用方(`store.update`)—— 本模块不碰磁盘的契约不变。
- 不做房间级覆盖:脚注只挂终答,逐房开关没有意义(工具流有房级覆盖是因为
  owner 房/guest 协作房的刷度诉求不同,spec #299)。故 command-registry 标注
  `stage: "adminCommands"`(单归属,不像 `/toggletools` 那样双面)。
- 不改 `StatusFooterInfo`、`appendStatusFooter`、`collectStatusFooter` 的形状与容错
  语义;不改工具循环中间消息(本就不挂脚注);不改活卡聚合(与 hideToolCalls
  的旁路关系不变)。

## 测试决策(Testing Decisions)

- `tests/auth-engine.test.ts`:`/togglefooter` 翻转值以效果回传(不碰存储)、回执
  带 📝(键缺失会输出键名)、两次翻转回到原值 —— 与 `/toggletools` 同钉法。
- `tests/router-projects.test.ts`:夹具新增 `hideStatusFooter` 注入,终答
  `toBe("all done")` 且不含 `📂`/`---` —— 与上方「开启形状」用例成对。
- `tests/guest-policy.test.ts`:访客禁列表加 `/togglefooter`(表是单一声明点)。

## 影响面与不变项(Out of scope)

- 不动 `/toggletools` 与其房级覆盖;不动 `/status` 的显示;不新增配置向导项
  (与 `hideToolCalls` 同策略:手编配置 + 命令皆可)。
- 已开启脚注的历史消息不受影响 —— 关的是出站,不是渲染。
