/**
 * Admin command handling for the auth engine (/trusted /revoke /channels
 * /enable /disable /toggletools /togglefooter /togglemention + challenge-code
 * entry).
 *
 * Pure input → output: text + identity in, handled / replies /
 * notifications / effects out. The engine's in-memory mutations happen
 * through ChallengeAuth methods; persistence (auth snapshot, tool-call and
 * status-footer visibility) is returned as effects for the CALLER to apply
 * through the injected config store — this module touches no disk and holds
 * no state.
 */

import { t } from "../i18n/index.js";
import { displayIdentity, namespacedId } from "../identity.js";
import { type ChallengeAuth, MAX_PAIRING_ATTEMPTS, PAIRING_BLOCK_MINUTES, parseChannelMode } from "./challenge-auth.js";

export type AdminEffect =
  | { kind: "persistAuth" }
  | { kind: "hideToolCalls"; value: boolean }
  /** 回复末尾状态脚注开关(全局显示偏好,与 hideToolCalls 同族:效果回传
   *  给调用方落盘,本模块不碰配置)。 */
  | { kind: "hideStatusFooter"; value: boolean }
  /** 终答是否点名提问人(spec #364):与上面两个显示偏好同契约 —— 效果
   *  回传给调用方落盘,本模块不碰配置。注意它是**正**字段:true = 点名。 */
  | { kind: "mentionAsker"; value: boolean }
  /** Whether hand-written handles in an answer become real mentions
   *  (mentionHandles): same contract as the display preferences above — the
   *  effect travels back to the caller, this module never writes config. */
  | { kind: "mentionHandles"; value: boolean }
  /** 已读回执开关(同上族):正语义,true = 发回执。 */
  | { kind: "readReceipts"; value: boolean }
  /** Trust was just granted to this user via a passed challenge — the caller
   *  invites them into the organizational space (fire-once, best-effort). */
  | { kind: "spaceInvite"; userId: string; transport?: string }
  /** Trust was just granted to this user via a passed challenge — the caller
   *  also invites them into the management room (where /pmctl lives;
   *  fire-once, best-effort, space mode only). */
  | { kind: "managementRoomInvite"; userId: string; transport?: string }
  /** Trust was just revoked from this user — the caller strips the admin
   *  power this instance once granted (every managed room, PL 0; best-effort,
   *  see demoteTrustedUserEverywhere). The userId arrives in the stored
   *  namespaced form ("matrix:@user:server") so the demotion hits the right
   *  MXID however the admin spelled the command argument. */
  | { kind: "powerDemote"; userId: string; transport?: string };

export interface AdminNotification {
  message: string;
  level: "info" | "warning";
}

export interface AdminCommandInput {
  text: string;
  userId: string;
  transport?: string;
  /** The conversation the message arrived in (6-digit pairing hints key on it). */
  chatId?: string;
  /** Current tool-call visibility (read by the caller before dispatch). */
  hideToolCalls?: boolean;
  /** Current status-footer visibility (same read-then-flip contract). */
  hideStatusFooter?: boolean;
  /** Current asker-mention state (same read-then-flip contract, positive
   *  field: true = 终答点名)。 */
  mentionAsker?: boolean;
  /** Current handle-mention state (same read-then-flip contract, positive:
   *  true = a `@name` in the answer that matches a room member is tagged). */
  mentionHandles?: boolean;
  /** Current read-receipt state (same contract, positive: true = 发已读回执;
   *  缺省未写 = 开,所以下一次翻转要仍到「关」)。 */
  readReceipts?: boolean;
}

export interface AdminCommandResult {
  handled: boolean;
  replies: string[];
  notifications: AdminNotification[];
  effects: AdminEffect[];
  /** 审计裁决(issue #124):纯模块认定「这发生了什么」,router 落账 ——
   *  认证与信任面(配对成败、/trusted、/revoke)在唯一入口处记全。
   *  Absence = 该动作不进审计。 */
  audit?: { event: string; detail?: string };
}

function handled(result: Omit<AdminCommandResult, "handled">): AdminCommandResult {
  return { handled: true, ...result };
}

/** Admin command help — the auth-owned admin group of the unified /help output
 *  (assembled by the command map; three threshold-annotated sections plus the
 *  pairing footnote. The management-room guide belongs to the router and
 *  pi-command help to the command map). */
export function adminCommandHelpText(): string {
  return t("auth.help.admin");
}

/**
 * Handle bridge admin commands and challenge-code entry in DMs.
 * Returns handled: false when the text is not an admin command and no
 * challenge validation applies (the caller then continues its pipeline).
 */
export function handleAdminCommand(auth: ChallengeAuth, input: AdminCommandInput): AdminCommandResult {
  const namespacedUserId = namespacedId(input.userId, input.transport);

  // Non-admin users: challenge-code entry (only when a challenge is active).
  if (!auth.isTrustedUser(input.userId, input.transport)) {
    if (/^\d{6}$/.test(input.text.trim())) {
      const outcome = auth.validateChallengeCode(namespacedUserId, input.text.trim());
      switch (outcome) {
        case "authenticated":
          return handled({
            replies: [t("auth.pairing.success")],
            notifications: [],
            effects: [
              { kind: "persistAuth" },
              { kind: "spaceInvite", userId: input.userId, transport: input.transport },
              { kind: "managementRoomInvite", userId: input.userId, transport: input.transport },
            ],
            audit: { event: "pairing.success", detail: `${displayIdentity(namespacedUserId)} passed the pairing challenge` },
          });
        case "expired":
          return handled({
            replies: [t("auth.pairing.expired")],
            notifications: [],
            effects: [],
          });
        case "blocked":
          return handled({
            replies: [t("auth.pairing.tooManyAttempts", { minutes: PAIRING_BLOCK_MINUTES })],
            notifications: [],
            effects: [],
            audit: { event: "pairing.blocked", detail: `${displayIdentity(namespacedUserId)} blocked after ${MAX_PAIRING_ATTEMPTS} failed codes` },
          });
        case "wrong":
          return handled({
            replies: [t("auth.pairing.wrongCode", { attempts: auth.attemptsLeft(namespacedUserId) })],
            notifications: [],
            effects: [],
            audit: { event: "pairing.wrong", detail: `${displayIdentity(namespacedUserId)} entered a wrong code (${auth.attemptsLeft(namespacedUserId)} left)` },
          });
        case "none":
          // A 6-digit message with no pairing in flight: most likely the user
          // is answering in the wrong chat (or typing a stray number). One
          // gentle pointer per (user, chat), cooldown-backed (spec #93 票3).
          if (input.chatId && auth.shouldHintPairing(namespacedUserId, input.chatId)) {
            return handled({
              replies: [t("auth.pairing.noPendingHint")],
              notifications: [],
              effects: [],
            });
          }
          return { handled: false, replies: [], notifications: [], effects: [] };
      }
    }
    return { handled: false, replies: [], notifications: [], effects: [] };
  }

  // Admin commands
  const parts = input.text.split(/\s+/);
  const cmd = parts[0].toLowerCase();

  switch (cmd) {
    case "/enable": {
      if (parts.length < 3) {
        return handled({ replies: [t("cmd.enable.usage")], notifications: [], effects: [] });
      }
      const mode = parseChannelMode(parts[2]);
      if (mode === undefined) {
        return handled({ replies: [t("cmd.enable.usage")], notifications: [], effects: [] });
      }
      auth.enableChannel(parts[1], mode);
      return handled({
        replies: [t("cmd.enable.ok", { chatId: parts[1], mode })],
        notifications: [{ message: t("cmd.enable.notify", { chatId: parts[1], mode }), level: "info" }],
        effects: [{ kind: "persistAuth" }],
      });
    }

    case "/disable": {
      if (parts.length < 2) {
        return handled({ replies: [t("cmd.disable.usage")], notifications: [], effects: [] });
      }
      auth.disableChannel(parts[1]);
      return handled({
        replies: [t("cmd.disable.ok", { chatId: parts[1] })],
        notifications: [{ message: t("cmd.disable.notify", { chatId: parts[1] }), level: "info" }],
        effects: [{ kind: "persistAuth" }],
      });
    }

    case "/channels": {
      const channels = auth
        .exportConfig()
        .channels;
      const lines = Object.entries(channels).map(
        ([id, channel]) => `• ${id}: ${channel.enabled ? "✅" : "❌"} (${channel.mode})`
      );
      return handled({ replies: [lines.join("\n") || t("cmd.channels.empty")], notifications: [], effects: [] });
    }

    case "/trusted": {
      const snapshot = auth.exportConfig();
      const trusted = snapshot.trustedUsers.map(displayIdentity).join(", ");
      return handled({
        replies: [t("cmd.trusted.list", { count: snapshot.trustedUsers.length, users: trusted || t("cmd.trusted.none") })],
        notifications: [],
        effects: [],
        audit: { event: "trust.list", detail: `listed ${snapshot.trustedUsers.length} trusted user(s)` },
      });
    }

    case "/toggletools": {
      const next = !input.hideToolCalls;
      return handled({
        replies: [t("cmd.toggletools.ok", { state: next ? t("cmd.toggletools.hidden") : t("cmd.toggletools.shown") })],
        notifications: [],
        effects: [{ kind: "hideToolCalls", value: next }],
      });
    }

    case "/togglefooter": {
      // 终答末尾的状态脚注(📂 路径 · 📜 上下文 · 🤖 模型):全局显示偏好,
      // 与 /toggletools 同契约 —— 只回传效果,落盘归调用方。
      const next = !input.hideStatusFooter;
      return handled({
        replies: [t("cmd.togglefooter.ok", { state: next ? t("cmd.togglefooter.hidden") : t("cmd.togglefooter.shown") })],
        notifications: [],
        effects: [{ kind: "hideStatusFooter", value: next }],
      });
    }

    case "/togglemention": {
      // 终答点名提问人(行首 @user:server + MSC3089 m.mentions):他不在房间里
      // 盯着也能被通知到。与 /togglefooter 同契约 —— 只回传效果,落盘归调用方。
      const next = !input.mentionAsker;
      return handled({
        replies: [t("cmd.togglemention.ok", { state: next ? t("cmd.togglemention.on") : t("cmd.togglemention.off") })],
        notifications: [],
        effects: [{ kind: "mentionAsker", value: next }],
      });
    }

    case "/toggletags": {
      // Handles the answer writes by hand (@claude, @ada:example.org) become
      // mentions when they match a member of this room. Same contract as
      // /togglemention: only the effect goes back, the caller persists it.
      const next = !input.mentionHandles;
      return handled({
        replies: [t("cmd.toggletags.ok", { state: next ? t("cmd.toggletags.on") : t("cmd.toggletags.off") })],
        notifications: [],
        effects: [{ kind: "mentionHandles", value: next }],
      });
    }

    case "/togglereads": {
      // 已读回执(MSC2228):开时对方看得到「pico 读到了哪条」。与上面两个
      // 同契约;缺省是**开**,所以未写过这一项的配置翻转后落到「关」。
      const next = !input.readReceipts;
      return handled({
        replies: [t("cmd.togglereads.ok", { state: next ? t("cmd.togglereads.on") : t("cmd.togglereads.off") })],
        notifications: [],
        effects: [{ kind: "readReceipts", value: next }],
      });
    }

    case "/revoke": {
      if (parts.length < 2) {
        return handled({
          replies: [t("cmd.revoke.usage")],
          notifications: [],
          effects: [],
        });
      }
      const revokeId = parts[1];
      // Capture the stored entry the revoke removes so the demotion effect can
      // carry it in its canonical namespaced form — the command argument may be
      // a bare display id (revokeUser also matches the native segment of
      // transport-prefixed entries; bare entries need the exact MXID).
      const trustedBefore = auth.exportConfig().trustedUsers;
      const revoked = auth.revokeUser(revokeId);
      if (revoked) {
        const removed = trustedBefore.find((id) => !auth.exportConfig().trustedUsers.includes(id));
        const effects: AdminEffect[] = [{ kind: "persistAuth" }];
        if (removed) {
          // Symmetric closed loop (ticket 3, issue #44): whoever was elevated
          // on trust gets demoted everywhere on revoke. Best-effort, same
          // failure semantics as the invite effects — a failed demotion never
          // un-revokes and never changes the reply.
          effects.push({ kind: "powerDemote", userId: removed });
        }
        return handled({
          replies: [t("cmd.revoke.ok", { userId: revokeId })],
          notifications: [{ message: t("cmd.revoke.notify", { userId: revokeId }), level: "warning" }],
          effects,
          audit: { event: "trust.revoke", detail: `revoked trust for ${removed ?? revokeId}` },
        });
      }
      return handled({
        replies: [t("cmd.revoke.notFound", { userId: revokeId })],
        notifications: [],
        effects: [],
        audit: { event: "trust.revoke", detail: `revoke missed: ${revokeId} not in trusted users` },
      });
    }

    default:
      return { handled: false, replies: [], notifications: [], effects: [] };
  }
}
