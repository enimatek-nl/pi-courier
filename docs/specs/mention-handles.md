# Tagging the people an answer names

Spec for `mentionHandles` / `/toggletags` (docs/specs/mention-handles.md), added 2026-11-25.
Companion to `364-asker-mention.md`, which tags the person who asked; this one tags the
people the answer talks about.

## The problem

pi names people in prose: "claude already reviewed this", "ask @ada:example.org". On Matrix
that is invisible. A client decides whether to notify from the structured MSC3089 field
`m.mentions.user_ids`, not from an `@name` in the body, so the person being talked about is
notified exactly as much as someone reading past the end of the sentence is.

## What it does

`/toggletags` (config `mentionHandles`, default off, global) makes the bridge scan every
**final answer** for hand-written handles, match each against the members of the room the
answer goes to, and prepend every person it recognised — beside the asker, in the same first
chunk, in the same `m.mentions.user_ids` list. One event, one notification per person.

```
@barry:server                      ← the asker (mentionAsker)
@claude:cluephone.org              ← named in the answer, matched to a room member
Reviewed with claude, who signed it off — see @claude:cluephone.org.
```

Handles are collected from prose only: fenced code blocks and `inline code` are blanked
before scanning, and a `/` ends a candidate, which is what keeps `@matrix-org/scopes` and
`@Override` in the source out of the running.

## Who is not tagged

Each of these is a decision, not a miss. They are reported in the debug log with the reason.

| Case | Reason | Why |
|---|---|---|
| nobody in the room answers to it | `unknown` | `@ada` in a room without an Ada notifies nobody useful |
| two members share the localpart | `ambiguous` | picking one would notify the wrong human |
| the bridge itself | `self` | `@pico` in prose is not the bridge paging itself |
| already mentioned (the asker) | `already` | one person, one mention |
| past the eighth handle | `capped` | a wall of mentions is how a bot gets muted |
| a full MXID that is not in the room | `unknown` | tagging strangers out of a conversation is spam |

Two shapes are collected but almost never resolve, and that is accepted deliberately:
prose-level `@keyframes` and decorators (`@Component`, `@Override`) cannot be told from a
person by shape alone, so they are dropped by the membership match instead of by a list of
known non-names. That keeps the rule honest: **the room is the namespace**, and only a person
who is already in the conversation can be pulled into it.

## Membership

Matching uses joined members of the target room, read through the transport
(`RoomOps.listRoomMembers`, `getJoinedRoomMembers` underneath). Comparison is
case-insensitive and the answer carries the member's own spelling.

The lookup sits in front of the first chunk of every final answer, so it is built not to
cost anything when it goes wrong: the result is cached per room for 60 seconds, the read
gives up after 2 seconds, and every failure — no transport, no permission, no answer in
time — resolves to "nobody". An unreadable room produces an answer byte-identical to one
with the feature off.

## Boundaries

- Final answers only, like the asker mention: a tool-loop step is not a person's notification.
- The bridge's own output is never re-scanned for its own MXID (`self`).
- Handles are read from the answer's text, not from the status footer appended to it.
- Non-Matrix transports have no rooms to match against, so the feature is a no-op there.

## Test anchors

| Anchor | What it pins |
|---|---|
| `tests/mention-handles.test.ts` — `extractHandles` | both spellings, order, dedup, trailing punctuation, code and scopes ignored |
| same file — `resolveHandles` | unique localpart match, ambiguity refusal, exact-MXID-only, self/already/cap, unreadable room |
| `tests/router-projects.test.ts` — `mentionTags adds the people the answer names to the first chunk` | asker first, then recognised handles, one `m.mentions` list |
| same — `mentionTags off leaves an answer that names people exactly as it was` | feature off = previous bytes |
| same — `mentionTags works with the asker mention off and skips the bridge` | the two flags are independent, and self is never tagged |
