# Spec #365: empty-turn notice (notifyEmptyTurn)

## Problem

A user message got nothing back. The agent ran eleven tool calls, its last
message carried only thinking and no text, and the room saw neither an answer nor
an error. The bridge log showed `reply to @user:` with an empty payload.

`turn.fullText === null` returned there without doing anything. Silence is
indistinguishable from being ignored, and the asker mention (spec #364) had
nothing to attach to: there was no message to tag.

## Decisions

1. A user turn that ends with no content at all sends one line,
   `router.turn.empty`. The notice is global config `notifyEmptyTurn`, on by
   default; `false` restores the old silence.
2. An aborted turn (`stopReason: "aborted"`) stays silent. Whoever typed `/stop`
   asked for silence.
3. A turn that still holds tool calls is mid-loop, not empty. A first cut
   announced those too and produced 25 lines in 3 minutes; the notice is for turn
   ends with no content and no pending tools.
4. No cause-specific wording. The cause is either an exhausted context or a model
   that returned nothing, and the bridge does not know which at this point —
   compaction is recorded in the module-level log helper, outside this closure —
   so the line stays generic.

## User stories

1. As a room member I want to see that a turn produced nothing, so I do not have
   to guess whether the bridge died.
2. As an admin I want to switch the notice off with `notifyEmptyTurn: false`, so a
   misbehaving model cannot fill my room.
3. As an admin I want `/stop` to produce nothing but the stop.

## Implementation record

- `src/types.ts`: `notifyEmptyTurn?: boolean` (default = on).
- `src/rpc/message-router.ts`: at `turn.fullText === null` — pending tools
  excluded, aborted excluded, config as the last gate; log line
  `turn produced no answer`.
- `src/i18n/{en,zh}.ts`: `router.turn.empty`.
- `tests/error-visibility.test.ts`: four cases — empty turn notifies, aborted
  stays silent, mid-loop stays silent, `notifyEmptyTurn: false` stays silent.
