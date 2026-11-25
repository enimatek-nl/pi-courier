/**
 * Room-member lookup behind the handle matcher (spec
 * docs/specs/mention-handles.md).
 *
 * The rules live in handles.ts; this is the only part that talks to a server.
 * Two properties matter because this sits in front of the first chunk of every
 * final answer:
 *
 *  - It never throws and never stalls. A room whose member list cannot be read
 *    in `memberTimeoutMs` yields no mentions, and the answer goes out as if the
 *    feature were off.
 *  - Member lists are cached briefly. The bridge answers many times in a row in
 *  one room, and a membership change is rare compared with that; one minute is
 *  long enough to collapse a burst and short enough that a person who just
 *  joined is known on the next answer after it.
 */
import { logger } from "../logger.js";
import type { RoomOps } from "../transports/interface.js";
import { extractHandles, resolveHandles, type HandleDecision } from "./handles.js";

export interface MentionResolverDeps {
  roomOps?: Pick<RoomOps, "listRoomMembers">;
  /** The bridge's own MXID, read lazily (it is known only after connect). */
  selfUserId?: () => string | null | undefined;
  /** Cache lifetime. */
  cacheTtlMs?: number;
  /** Give up on the lookup after this long. */
  memberTimeoutMs?: number;
  now?: () => number;
}

export interface MentionResolver {
  /** MXIDs to mention for this outgoing text, asker excluded (the caller already
   *  mentions them and passes them in `alreadyMentioned`). */
  resolve(chatId: string, text: string, alreadyMentioned?: readonly string[]): Promise<string[]>;
  /** Same, with the reasons — for the debug log. */
  resolveDetailed(chatId: string, text: string, alreadyMentioned?: readonly string[]): Promise<HandleDecision>;
  /** Test seam: drop a room's cached member list. */
  forget(chatId?: string): void;
}

const DEFAULT_TTL_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 2_000;

export function createMentionResolver(deps: MentionResolverDeps): MentionResolver {
  const ttlMs = deps.cacheTtlMs ?? DEFAULT_TTL_MS;
  const timeoutMs = deps.memberTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = deps.now ?? (() => Date.now());
  const cache = new Map<string, { at: number; members: string[] }>();

  async function members(chatId: string): Promise<string[]> {
    const hit = cache.get(chatId);
    if (hit && now() - hit.at < ttlMs) return hit.members;
    const list = deps.roomOps?.listRoomMembers;
    if (!list) return [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const pending = Promise.resolve(list.call(deps.roomOps, chatId));
      const result = await Promise.race([
        pending,
        new Promise<string[]>((resolve) => {
          timer = setTimeout(() => resolve([]), timeoutMs);
        })
      ]);
      const members = Array.isArray(result) ? result.filter((m): m is string => typeof m === "string") : [];
      cache.set(chatId, { at: now(), members });
      return members;
    } catch (err) {
      // A room we cannot read is a room where nobody gets tagged; the answer
      // still goes out. Log once per room per cache miss, not per attempt.
      logger.debug(`mention: member list for ${chatId} unavailable: ${String(err)}`);
      return [];
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function resolveDetailed(
    chatId: string,
    text: string,
    alreadyMentioned?: readonly string[]
  ): Promise<HandleDecision> {
    const handles = extractHandles(text);
    if (handles.length === 0) return { userIds: [], skipped: [] };
    const list = await members(chatId);
    if (list.length === 0) return { userIds: [], skipped: handles.map((handle) => ({ handle, reason: "unknown" as const })) };
    const decision = resolveHandles(handles, list, {
      selfUserId: deps.selfUserId?.(),
      alreadyMentioned
    });
    if (decision.skipped.length > 0) {
      logger.debug(`mention: left alone in ${chatId}: ${decision.skipped.map((s) => `${s.handle}(${s.reason})`).join(", ")}`);
    }
    return decision;
  }

  return {
    async resolve(chatId, text, alreadyMentioned) {
      return (await resolveDetailed(chatId, text, alreadyMentioned)).userIds;
    },
    resolveDetailed,
    forget(chatId) {
      if (chatId === undefined) cache.clear();
      else cache.delete(chatId);
    }
  };
}
