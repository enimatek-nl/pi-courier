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

Switching the guard on restarts the instance, and from the next message that
process is confined: `ProjectManager` spawns a guarded binding with
`-e <package>/jail/guard.js`, `--no-approve`, and a jail environment.

| Piece | Value | Why exactly this |
|---|---|---|
| Extension | `-e …/dist/jail/guard.js` | Loaded from the *package*, never from the jailed directory — configuration the confined party can write is not configuration. |
| Project resources | `--no-approve` | pi reads `.pi/extensions/` and `.pi/skills/` from the working directory when project trust is on, and trust is a global setting. A jail whose occupant can author the extension that loads next run is not confined. |
| `$HOME` | `<stateDir>/jails/<room>/home`, mode 0700 | Bridge-owned and outside the root, so the session cannot write its own `~/.ssh/config` or `~/.gitconfig`. Inside a jail, `~/.ssh` does not exist. |
| `PI_CODING_AGENT_DIR` | the real `<piHome>/agent` | pi needs its settings, skills, `AGENTS.md` and credentials; this is the read-only exception. Read-only because that directory is also where extensions live — writable, a jailed session could install code the host pi loads. |
| `~/.agents` | read-only, when present | The other place skills are kept. Refusing it would only make the agent worse. |
| `PI_COURIER_JAIL_ROOT` | the bound directory | Set by the bridge; the guard falls back to its own working directory, which the bridge sets to the same value, so root and binding cannot disagree. |
| `AGENTS.md` | written when arming if absent, never overwritten | Context-file discovery walks parent directories and needs no trust, so a jail under `/srv` inherits `/srv/AGENTS.md`. Arming gives the room instructions of its own. |

The three files split by concern: `rules.ts` decides (pure, unit-tested),
`guard.ts` adapts pi's `tool_call` event to that decision, `spawn.ts` builds the
environment. The guard refuses a path below the root, the jail home, or the
read-only set — resolved first: `~` against the *jail* home, `..` collapsed,
symlinks followed with `realpath`, a path that does not exist yet judged at its
nearest existing ancestor. Writes go to the root and the jail home only.

The read-only system set is deliberately not `/etc`, `/proc` and `/sys`
wholesale. It names what tools need (`resolv.conf`, certificates, `/dev/null`)
because `/etc/ssh/ssh_config` is recon and `/proc/<pid>/environ` is where the
bridge's own access token sits.

Bash is judged on the paths a command names — absolute, `~`, `$HOME`, `..` —
which is what an accident and a prompted-into-it mistake look like. It is a
recogniser, not a parser: `$(printf … | base64 -d)/etc/passwd` defeats any token
scan. Three levels, and the middle one is what ships:

- **binding alone** — separate process, session and default directory; stops the
  accidental `~/secrets` edit;
- **the guard** — refuses tool calls that reach outside, with the reason visible
  on the bridge's log (`[pi-courier jail] blocked …`);
- **a container per jail** — the only thing that stands between a hostile channel
  member and this machine: a stdio shim pointing `cliPath` at `podman run -i --rm`
  with the jail bind-mounted at the same path, one quadlet unit per jail, no docker
  socket inside. Provider credentials stay a host-side secret problem no mount list
  solves; ssh inside a jail is a scoped https token or one dedicated deploy key
  placed in that jail's home, never `~/.ssh`.

## Where the root comes from

The root is the instance's working directory, captured when the extension loads;
`PI_COURIER_JAIL_ROOT` makes it explicit and is namespaced so it cannot be
mistaken for a pi variable — pi knows no jail, sandbox or path-root variable
(checked against its environment-variable list, its documentation tree and its
CLI surface).

- the bridge sets that directory when spawning, so the enforced root and the bound
  directory are one value by construction;
- capturing at load matters: a `bash` tool running `cd /etc` moves its own
  subprocess, not the extension host, and pi has no `/cd`;
- the extension loads with `-e <path>`, never from the jailed directory.

## Proof the guard is live

Rules and wiring are unit-tested; against a real pi (v1.27+) the extension loads
and announces itself on stderr, which the bridge forwards to its log:

```console
$ PI_COURIER_JAIL_ROOT=/tmp/jailproof PI_COURIER_JAIL_HOME=/tmp/jailhome \
    pi --mode rpc -e dist/jail/guard.js --no-approve
[pi-courier jail] guarding /tmp/jailproof (home /tmp/jailhome)
```

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
| `tests/jail-rules.test.ts` (17) | traversal, symlink out, `~` against the jail home, sibling-prefix escape, the bash shapes, the sensitive half of `/etc` refused |
| `tests/jail-spawn.test.ts` (6) | `-e` + `--no-approve` + jail env on a guarded spawn, an unguarded spawn byte-identical, one home per room |
| `tests/jail-guard.test.ts` (4) | the compiled extension blocks an outside read, allows inside work, keeps the agent directory readable and unwritable, and still blocks an unknown tool |
| `tests/pmctl-controller.test.ts` — `guard on flips the flag and writes a starting AGENTS.md`, `never overwrites an AGENTS.md someone already wrote` | a jail gets instructions of its own without clobbering anyone's |
