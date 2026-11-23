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
store. `--bootstrap` is the write half of the same command and has its own section
below.

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

## Two rules that decide the shape

**A first cross-signing upload needs no user-interactive auth.** MSC3967 (stable
since v1.11; Synapse merged it in June 2024, PR #17284) removed the password
requirement for the *first* upload of `/_matrix/client/v3/keys/device_signing/upload`.
So the bootstrap tries the plain upload and only asks for a password if this
particular homeserver still demands a stage. That is why the command works
headless in the normal case.

**The master key does not have to be signed by a device.** MSC1756 says a master
key "may be signed by a device" — permissive. A self-signed MSK is legal, and
that matters because the bridge cannot produce a device signature at all: the
pinned binding has no signing call, and the device's private Ed25519 key exists
only inside the store the Rust binding owns (measured: `bot-sdk.json` next to the
store keeps the device *id* and room settings, no key material).

One naming rule cost a test before it cost a deployment. For **cross-signing**
keys the entry name in `keys` is `ed25519:` followed by the public key itself,
while for **device** keys the key id is the SHA-256 of the public key. Mixing them
up uploads something a server accepts and no client trusts.

## What `--bootstrap` does

```
pi-courier verify --bootstrap [--dry-run] [--device <id>] [--password-file <0600>] [--force]
```

Five steps, in this order, because each one can stop: generate MSK/SSK/USK
locally; self-check every signature against its own public key (nothing goes up
that fails its own check); `PUT /keys/device_signing/upload`; sign each of the
account's own devices with the SSK and push it with `POST /keys/signatures/upload`
(the stored device document goes back byte-for-byte with one signature added, its
own self-signature included); write the private keys to
`~/.local/state/pi-courier/cross-signing.json`, directory 0700, file 0600, via a
temp file and rename.

Refusals before any request goes out: a local bundle already exists (it would
orphan the identity it describes), the account already published an identity
(resetting an identity is a deliberate act, do it in the client you normally
verify with), the requested `--device` is not on the account, or an uploaded
public key collides with a device id (the server would answer `M_FORBIDDEN`).

A password is asked for only when the server asked for UIA. Then it comes from
`--password-file` or from a hidden terminal prompt, is used in exactly one
request body, and appears in no log line, no return value and no test output.

What it deliberately does not do: it does not upload the private keys to Secret
Storage (losing the bundle means losing the identity — see the warning the
command prints), it does not sign devices created later (a future bridge device
starts unverified until the command runs again for that device id), and it never
opens the crypto store.

## Still not here: emoji verification, measured 2026-11-23

The bridge cannot take part in an interactive verification, and that is a
dependency limit, not a missing feature.

1. **The pinned binding is old.** matrix-bot-sdk 0.8.0 depends on
   `@matrix-org/matrix-sdk-crypto-nodejs: ^0.4.0`, and 0.4.0 is what is installed.
   In 0.4, `OlmMachine.bootstrapCrossSigning(reset)` returns `void`: it can create
   the identity but hands back no upload payloads, and `outgoingRequests()` only
   yields keys-upload/query/claim, to-device, signature-upload and room-message —
   there is no request type for `PUT /keys/device_signing/upload`. 0.6 and 0.7 do
   return `CrossSigningBootstrapRequests`. There is also no generic sign-JSON call,
   which is why the bootstrap brings its own keys instead of asking the device.
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

## Non-goals

No password in argv, env, config or chat — a Matrix room is a bad carrier for a
secret: the bridge logs incoming message bodies and the session transcript is on
disk. No crypto-store migration, and no tool
that opens the store from outside the process that holds it. No hand-rolled
`m.key.verification.*` state machine in a bridge whose job is to carry messages.
