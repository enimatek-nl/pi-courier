# `pi-courier verify` — the encryption view from outside

Spec: no issue number; asked for directly on 2026-11-23 while looking at why
Element marks the bot's session as unverified and asking whether the bridge can
verify its own device and keep the keys on disk.

## What ships here

`pi-courier verify` answers one question with one page: what does this account's
end-to-end encryption look like to someone else. It reads two endpoints —
`GET /_matrix/client/v3/account/whoami` to learn which account the configured
token is, `POST /_matrix/client/v3/keys/query` for that account's own keys — and
prints three things: the devices and who signed each one, whether the account
published a cross-signing identity (and until when those keys are valid), and
whether a local key bundle exists with tight permissions. `--json` prints the
same report machine-readable. It writes nothing and never touches the crypto
store.

```
$ pi-courier verify
Account: @pico:matrix.enimatek.nl
No cross-signing identity published — nothing can mark this account's devices as verified.
  device    PICOURIER4RH4ZVKD  unsigned — signers: @pico:matrix.enimatek.nl
Local key bundle: none at ~/.local/state/pi-courier/cross-signing.json
```

The rule that makes the report trustworthy: a device counts as verified when the
account's **self-signing key** signed it, which is what a client shows as
"verified". Signing by the device itself is printed, but it is not evidence —
every device self-signs.

## Why the other half is not here, measured 2026-11-23

Verifying the bridge's own device means getting a cross-signing identity, and
that runs into four measured walls.

1. **The pinned binding is old.** matrix-bot-sdk 0.8.0 depends on
   `@matrix-org/matrix-sdk-crypto-nodejs: ^0.4.0`, and 0.4.0 is what is installed.
   In 0.4, `OlmMachine.bootstrapCrossSigning(reset)` returns `void`: it can create
   the identity but hands back no upload payloads, and `outgoingRequests()` only
   yields keys-upload/query/claim, to-device, signature-upload and room-message —
   there is no request type for `PUT /keys/device_signing/upload`. 0.6 and 0.7 do
   return `CrossSigningBootstrapRequests`.
2. **The store does not survive the bump.** `matrix-sdk-crypto.sqlite3` in the
   crypto directory is the old schema (`device`, `identity`, `session`, `secrets`,
   `kv`, `olm_hash`, …, no engine-info table). Opening a copy of it with 0.6.0,
   0.6.6 and 0.7.0 each failed with `missing field \`user_id\`` — the first two
   during migrations. So a bump does not upgrade the store, it loses the device
   and every megolm session behind it: #smaltino would go unreadable from the
   first day.
3. **Node too old for the new binding.** 0.7.0 declares `engines.node >= 24`; this
   host runs v22.23.1. It loaded and reached the migration error, but it is not a
   supported combination.
4. **No verification machine exists in any published binding.** Neither 0.4.0 nor
   0.7.0 exposes `m.key.verification.*` — no `startVerification`, no SAS, no
   emoji. Interactive "verify this session" cannot be built on this dependency at
   all; it needs a different crypto layer (matrix-js-sdk has it).

The account picture is worth recording too, because it says how much of the
warning is structural: `pi-courier verify` shows pico with one self-signed device
and no identity, and `@enimatek:matrix.enimatek.nl` has eleven devices and no
identity either. Nothing on this homeserver is cross-signed, so there is no key
that *could* mark anything verified yet.

## The remaining half, and its cost

The useful target is: pico gets an MSK/SSK/USK, the SSK signs `PICOURIER4RH4ZVKD`,
and Element's warning goes away. Two things stand in the way, and they are
different in kind.

*Uploading a cross-signing identity needs user-interactive auth.* An access token
from the headless login is not enough; Synapse wants a stage like a password. The
design decision taken here: the password never passes through the bridge, the
chat, argv or the environment — the command prints the exact request with its
`auth` block and the operator runs it. A one-shot secret file at mode 0600, read
once and shredded, is the fallback.

*The device signature has to come from the device.* `PUT /keys/device_signing/upload`
wants the MSK signed by a device of the uploading session, and the SSK signature
on the bridge's device has to be produced by whoever holds the SSK. Three ways to
get there, none free:

1. Inside the bridge: reach the live `OlmMachine` (bot-sdk keeps
   `CryptoClient.engine` private, so this is a documented escape hatch) and use
   its `sign()`. No store conflict — the bridge owns it — but it puts a
   privileged code path in the always-on process.
2. From the CLI with the bridge stopped: clean ownership of the store, at the cost
   of a stopped bridge while the command runs, and it still needs 0.4 to hand back
   the payloads it does not expose.
3. From a throwaway login: a temporary session generates the identity, signs its
   own MSK, uploads with UIA, then signs the bridge's device with the SSK. It needs
   no store at all, but it hinges on whether Synapse accepts an SSK signature for
   your own device through `POST /keys/signatures/upload` (own-device re-publication
   through `/keys/upload` is device-local, so this is the only door) — unanswered
   as of today, and it needs a UIA run to settle.

Until that is answered, `verify` stops at reading, and says so by omission: no
identity line, `unsigned`, no bundle.

## Non-goals

No password in argv, env, config or chat. No crypto-store migration, and no tool
that opens the store from outside the process that holds it. No hand-rolled
`m.key.verification.*` state machine in a bridge whose job is to carry messages.
