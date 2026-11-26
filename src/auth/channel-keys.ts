/**
 * Channel keys that events can actually carry (docs/specs/channel-jail.md).
 *
 * Authorisation looks a room up by exact key: `channelAuth.get(chatId)` with the
 * room id off the event. A config key written as `#alias:server` therefore
 * matches nothing — the room stays unenabled while the config and `/channels`
 * both insist it is on, which is the worst kind of failure because the evidence
 * says it worked.
 *
 * Two repairs, both here so the rules live in one place:
 *
 * - **startup migration** rewrites existing alias keys to the room ids they
 *   name. It resolves through the transport, so it is async; it reports every
 *   move, and refuses to guess when the homeserver cannot resolve the alias.
 * - **command normalisation** keeps new phantoms from being written when an
 *   operator types `/enable #alias:server all` — Element copies aliases, so the
 *   alias is the address they have.
 *
 * A conflict (the same room entered twice, once by alias and once by id) is
 * resolved in favour of the id entry and reported, never silently merged: two
 * entries means two humans made two decisions, and only one of them can win.
 */
import { logger } from "../logger.js";

/** Resolves `#alias:server` to `!room:server`, or null when the homeserver says no. */
export type ResolveRoomId = (alias: string) => Promise<string | null>;

export interface ChannelEntryLike {
  enabled: boolean;
  mode: string;
  [key: string]: unknown;
}

export interface MigrationReport<T> {
  /** The channels map to store: identical to the input when nothing was an alias. */
  channels: Record<string, T>;
  /** Alias keys that were rewritten, as `alias → id`. */
  moved: string[];
  /** Alias keys dropped because the room already had an id entry (the id wins). */
  dropped: string[];
  /** Alias keys left exactly as they were, because resolution failed. */
  unresolved: string[];
  /** True when nothing was changed, so the caller can skip a config write. */
  unchanged: boolean;
}

/**
 * Rewrite every `#alias` key in a channels map to the room id it names.
 *
 * Resolution failures are kept rather than deleted: an entry that cannot be
 * resolved today might resolve after a rejoin, and dropping an operator's
 * configuration because the homeserver was briefly unreachable is a worse
 * outcome than the inert entry we started with.
 */
export async function migrateAliasChannelKeys<T extends ChannelEntryLike>(
  channels: Record<string, T>,
  resolve: ResolveRoomId
): Promise<MigrationReport<T>> {
  const aliasKeys = Object.keys(channels).filter((key) => key.startsWith("#"));
  if (aliasKeys.length === 0) {
    return { channels, moved: [], dropped: [], unresolved: [], unchanged: true };
  }

  const next: Record<string, T> = { ...channels };
  const moved: string[] = [];
  const dropped: string[] = [];
  const unresolved: string[] = [];

  for (const alias of aliasKeys) {
    const entry = next[alias]!;
    let roomId: string | null = null;
    try {
      roomId = await resolve(alias);
    } catch {
      roomId = null;
    }
    if (!roomId) {
      unresolved.push(alias);
      continue;
    }
    delete next[alias];
    const existing = next[roomId];
    if (existing) {
      // Both spellings named this room. The id entry stays: it is the one that
      // has been working, and silently overwriting its mode would be a change
      // nobody asked for.
      dropped.push(`${alias} → ${roomId} (kept the entry already under the id)`);
      continue;
    }
    next[roomId] = entry;
    moved.push(`${alias} → ${roomId}`);
  }

  const unchanged = moved.length === 0 && dropped.length === 0;
  for (const line of [...moved, ...dropped]) logger.info(`[channel-keys] ${line}`);
  for (const alias of unresolved) logger.warn(`[channel-keys] ${alias} does not resolve; left as an inert key`);
  return { channels: next, moved, dropped, unresolved, unchanged };
}

/**
 * Replace one `#alias` argument with the room id it names, for the commands that
 * write channel state.
 *
 * Returns the text unchanged when the argument is not an alias or cannot be
 * resolved — writing an alias is what happened before, and `/channels` now marks
 * such an entry, so a failed resolution stays visible rather than silent.
 */
export async function normalizeChannelArgument(text: string, resolve: ResolveRoomId): Promise<string> {
  const parts = text.trim().split(/\s+/);
  const target = parts[1];
  if (!target || !target.startsWith("#")) return text;
  let roomId: string | null = null;
  try {
    roomId = await resolve(target);
  } catch {
    roomId = null;
  }
  if (!roomId) return text;
  parts[1] = roomId;
  return parts.join(" ");
}
