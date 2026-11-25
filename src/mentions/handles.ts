/**
 * Outgoing handle matching (spec docs/specs/mention-handles.md).
 *
 * pi often writes people down by hand — "@claude looked at this", "ask
 * @ada:example.org" — and a bare `@name` in a message body is not a mention:
 * Matrix clients notify from the structured `m.mentions.user_ids` field
 * (MSC3089) only. This module turns those hand-written handles into real MXIDs
 * by matching them against who is actually in the room, so the bridge can add
 * them to the mention list of the final answer.
 *
 * Pure: no I/O, no config, no clock. `resolveHandles` takes the member list the
 * caller already fetched, which keeps every rule below testable on its own.
 */

/** Default ceiling on how many people one answer can tag. A wall of mentions
 *  is how a bot gets muted; the first few in text order win. */
export const MAX_HANDLE_MENTIONS = 8;

/**
 * A Matrix-flavoured handle in running text: `@local` or `@local:server`,
 * started at a word boundary so e-mail addresses (`me@example.org`) never
 * qualify. Localparts follow the server-name grammar (RFC 9110 quoted-string
 * rules as Matrix applies them); `/` is deliberately NOT a character here —
 * npm scopes (`@matrix-org/matrix-sdk-crypto-nodejs`) are the single most
 * common `@thing` in model output about this project and never a person.
 *
 * The trailing class drops sentence punctuation: "ping @ada." must resolve
 * `ada`, not `ada.`.
 */
const HANDLE_RE = /(?:^|[\s(\[<])@([a-z0-9._=+-]+(?::[a-z0-9.:-]+)?)(?=$|[\s)\].,;:!?"'`])/gi;

/** Code is not prose: `@Override`, `@0x1f`, `@keyframes` and every decorator
 *  live in code spans and fences, where no human is being addressed. */
const CODE_FENCE_RE = /^[ \t]*(```|~~~)[\s\S]*?^[ \t]*\1[ \t]*$/gm;
const CODE_SPAN_RE = /`[^`\n]*`/g;

/** Handles written in the text, first-appearance order, duplicates dropped.
 *  Comparison is case-insensitive (Element completes to lower case), so the
 *  keys here are lower-cased while the returned list keeps what was written. */
export function extractHandles(text: string): string[] {
  const prose = text.replace(CODE_FENCE_RE, " ").replace(CODE_SPAN_RE, " ");
  const out: string[] = [];
  const seen = new Set<string>();
  for (const match of prose.matchAll(HANDLE_RE)) {
    // A localpart may legally end in `.`/`_`/`-`, so "ping @ada." matches with
    // the period attached. Sentence punctuation is trimmed back; a handle that
    // genuinely ends in one of those is rare enough to trade against the far
    // more common case, and the worst outcome is nobody gets tagged.
    const handle = match[1]!.replace(/[._=+-]+$/, "");
    if (!handle) continue;
    const key = handle.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(handle);
  }
  return out;
}

function localpart(mxid: string): string {
  const body = mxid.startsWith("@") ? mxid.slice(1) : mxid;
  const colon = body.indexOf(":");
  return colon === -1 ? body : body.slice(0, colon);
}

export interface ResolveOptions {
  /** The bridge's own user ID — never tag itself. */
  selfUserId?: string | null;
  /** MXIDs already mentioned by the caller (the asker), so one person is not
   *  named twice in the same line. */
  alreadyMentioned?: readonly string[];
  /** Ceiling for the returned list. */
  max?: number;
}

export interface HandleDecision {
  /** Full MXIDs to mention, in the order the handles appeared. */
  userIds: string[];
  /** Handles that were found but not turned into a mention, with the reason —
   *  for a debug line. Never a signal to retry: each reason is a decision.
   *  `ambiguous` means two room members share the localpart and picking one
   *  would notify the wrong human. */
  skipped: Array<{ handle: string; reason: "unknown" | "ambiguous" | "self" | "already" | "capped" }>;
}

/**
 * Match handles against room members. A handle must land on exactly one member
 * of the room the answer goes to: `@claude` resolves when one member's localpart
 * is `claude`, and `@claude:cluephone.org` only when that exact MXID is in the
 * room. People outside the room are left alone (a mention there notifies nobody
 * in the conversation and reads as spam to whoever receives it), and so is
 * anything ambiguous.
 */
export function resolveHandles(
  handles: readonly string[],
  members: readonly string[],
  opts: ResolveOptions = {}
): HandleDecision {
  const max = opts.max ?? MAX_HANDLE_MENTIONS;
  const skip = new Set((opts.alreadyMentioned ?? []).map((id) => id.toLowerCase()));
  const self = opts.selfUserId?.toLowerCase();
  const lowered = members.map((m) => ({ mxid: m, lower: m.toLowerCase(), local: localpart(m).toLowerCase() }));

  const userIds: string[] = [];
  const skipped: HandleDecision["skipped"] = [];
  // Who a handle lands on, before any of the reasons not to tag them. Self and
  // asker are checked against the resolved member, never against the handle as
  // written: `@pico` is the bridge too, and comparing the text would let it tag
  // itself.
  const decide = (handle: string, target: { mxid: string; lower: string } | undefined, ambiguous: boolean) => {
    if (!target) {
      skipped.push({ handle, reason: ambiguous ? "ambiguous" : "unknown" });
      return;
    }
    if (target.lower === self) {
      skipped.push({ handle, reason: "self" });
    } else if (skip.has(target.lower)) {
      skipped.push({ handle, reason: "already" });
    } else if (userIds.some((id) => id.toLowerCase() === target.lower)) {
      // Same person written two ways in one answer is one mention.
    } else if (userIds.length >= max) {
      skipped.push({ handle, reason: "capped" });
    } else {
      userIds.push(target.mxid);
    }
  };

  for (const handle of handles) {
    const key = handle.startsWith("@") ? handle.toLowerCase() : `@${handle.toLowerCase()}`;
    const exact = lowered.find((m) => m.lower === key);
    if (exact) {
      decide(handle, exact, false);
      continue;
    }
    // Bare localpart: only when the room holds exactly one such person.
    const matches = lowered.filter((m) => `@${m.local}` === key);
    decide(handle, matches.length === 1 ? matches[0] : undefined, matches.length > 1);
  }
  return { userIds, skipped };
}

/** The line a caller prepends to an answer: asker first, then the handles, one
 *  MXID per line — the shape clients turn into a mention pill. Empty when there
 *  is nobody to name, so callers can pass the text through unchanged. */
export function mentionPrefix(userIds: readonly string[]): string {
  return userIds.join("\n");
}
