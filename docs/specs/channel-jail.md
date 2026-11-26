# Jailing a channel in a directory

Requested 2026-11-25: every channel the bridge joins should be able to say which
directory its pi session may work in, so a channel shared with other people cannot
walk the bridge through the rest of the machine.

## The shape that was built

No new command family and no second config store. A jail is **a project binding with
the path guard switched on**, on top of the instance model that already existed:
`ProjectManager.getRpcForRoom()` gives a bound room its own pi process, its own `cwd`
and its own session directory.

| Command | Room | What it does |
|---|---|---|
| `/pmctl bind <#alias\|room ID> <path>` | admin room | give that room its own pi process, rooted at `<path>` |
| `/pmctl guard <#alias\|room ID> <on\|off>` | admin room | the jail switch on that binding |
| `/pmctl unbind <#alias\|room ID>` | admin room | release the room; the directory is named in the reply and left alone |
| `/pmctl list` | admin room | shows `🔒 jailed` beside the directory it covers |

Gated on the admin room on purpose: whoever can jail a channel is whoever owns the
bridge, and a channel member can never widen their own sandbox. In multi-project mode
the admin room is the management room; in single-project mode it is the admin's DM —
the same reading `/login` and `/update` already use. The binding verbs work in
single-project mode, because jailing one channel should not ask the operator to switch
the whole bridge into multi-project mode.

`/pmctl rm` refuses a guarded project: dropping the record would stop the instance and
leave the directory guarded by nobody, which is worse than no jail because it looks like
one. `guard off`, then `unbind`.

## Two properties the model had to gain

**A guarded room never shares a process.** The guard lives in the child process, so a
jailed room running on the shared instance would execute its tools under somebody
else's root — the one configuration that looks confined and is not. `getRpcForRoom()`
therefore treats a guarded entry as authoritative even when `multiProject` is off, and
`labelForRoom()` follows suit so the logs attribute the work correctly.

**Addresses are stored as ids.** Operators paste what the client shows them, so `#alias:server`
is accepted, resolved through the homeserver (`RoomOps.resolveRoomId`, over the SDK's
`resolveRoom`) and stored as `!opaque:server`. An alias that does not resolve is reported
and nothing is written. This mattered because channel lookups are exact-match on the raw
`chatId` (`channelAuth.get(chatId)`), so an alias key can never match an incoming event —
a bug `/enable` still has, and one the jail must not inherit.

## What the guard refuses at bind time

| Rule | Why |
|---|---|
| absolute path, and it must already exist | a jail belongs on a directory you meant, not one typed into being |
| not `/`, not `$HOME` | a root that broad contains everything, i.e. it confines nothing |
| not over `~/.ssh` or `~/.pi`, either direction | a jail that covers the credential folders protects nothing worth naming |
| not containing the bridge's own workdir | from there a jailed session edits the bridge, its config and its access token |
| one directory, one guarded room | a guard whose root is another room's working directory confines nothing |

Danger is checked before existence, so the answer does not depend on what happens to be
on disk while the command is typed. A jail *inside* the bridge's tree is allowed — that
is where jails usually live — and unguarded rooms may still share a checkout, which is
what `/pmctl wt` and sibling rooms are for.

## What is confined, and what is not

Switching the guard on restarts the instance, and from the next message that process
carries the guard. **The guard itself is the next change**, tracked here until it ships:
an extension the jailed instance loads with `-e`, refusing `tool_call`s that reach
outside its root — and, because the root must never disagree with the directory the
operator bound, **the root is the instance's working directory**, read at extension
load (see "Where the root comes from"). Until that lands, `guard on` is honest only about the
instance and the directory, and says so out loud:

> `• path guard: off (directory only — a separate cwd is not confinement)`

That sentence is not decoration. pi's own security documentation is explicit that the
working folder "does not prevent commands from accessing other paths available to the Pi
process", so:

- **binding alone** buys a separate process, a separate session and a separate default
  directory. It stops the accidental `~/secrets` edit and makes each channel's work
  separately visible in the logs;
- **the guard** will refuse tool calls that name a path outside the root. It constrains
  tool calls, not the process: it stops the accident, the confused guest and the injected
  instruction, and it does not stop a determined model that finds a tool outside the
  guard's reach;
- **a real boundary** — the jailed instance inside a container with only that directory
  mounted — is what stands between a hostile channel member and this machine. That is the
  documented direction (pi describes Docker/OpenShell/Gondolin for exactly this) and it
  reuses everything above.

## Where the root comes from

`PI_JAIL_ROOT` was the design's first idea and is **not a pi variable** — pi knows no
jail, sandbox or path-root variable (checked against its environment-variable list, the
whole documentation tree and its CLI surface), and inventing a name that looks like one
would read as if pi understood it. The root the guard enforces is therefore read from the
child process's working directory, captured when the extension loads:

- the bridge already sets that directory when it spawns the instance, so the enforced root
  and the bound directory are the same value by construction — one cannot be forgotten,
  renamed or left pointing at yesterday's path;
- capturing it at load matters: the extension runs inside the pi process, so a `bash` tool
  running `cd /etc` changes its own subprocess, not the host's directory, and pi offers no
  `/cd` to move the session (both checked);
- if a root different from the working directory is ever genuinely needed, the override is
  `PI_COURIER_JAIL_ROOT`, namespaced so it cannot be mistaken for pi's own — `RpcClient`
  accepts `args` and `env`, and the bridge already merges environment variables for the
  proxy feature.

The extension is loaded with `-e <path>` (a CLI extension), not from the jailed directory:
project-local extensions are gated on project trust, and, more decisively, configuration
that lives inside a jailed directory is configuration the jailed session can edit. Security
settings do not get stored where the confined party has write access.

## Test anchors

| Anchor | What it pins |
|---|---|
| `tests/project-manager.test.ts` — `gives a guarded room its own process in single-project mode` | the routing rule, and the `cwd` it spawns with |
| same — `keeps an unguarded room on the shared instance` | nothing changed for ordinary bindings |
| `tests/pmctl-controller.test.ts` — `binds a channel in single-project mode from the admin DM` | the binding verbs survive single-project mode |
| same — `refuses to bind outside the admin room`, `refuses to bind for a non-admin` | the gate moved, it did not widen |
| same — `stores the resolved room id, never the alias that was typed`, `refuses an alias that does not resolve` | keys that events can match |
| same — the four `refuses a …` cases + `refuses a second guarded room over one directory` | the directory rules and the one-jail-one-directory rule |
| same — `refuses /pmctl rm on a guarded project` | no orphan jails |
| `tests/config.test.ts` — `keeps a guarded project binding across save and reload` | a jail that survives a restart |
