/**
 * `verify` 的只读半边(spec:verify-device.md):canonical JSON、/keys/query
 * 解读、签名归属、本地密钥包权限、ed25519 验签与取数驱动。纯函数 + 注入
 * fetch,不起桥也不碰 crypto store。
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  base64Unpadded,
  canonicalJson,
  fetchKeyReport,
  generateSigningKey,
  keyBundleStatus,
  readKeyBundle,
  readKeyQuery,
  signatureSummary,
  statusLines,
  verifyEd25519,
  withoutSignatures,
  writeKeyBundle,
} from "../src/verify/cross-signing.js";

const USER = "@pico:example.org";

/** 64 字符的假公钥(可区分即可,不参与密码学)。 */
function fakeKey(marker: string): string {
  return (marker.repeat(64) + "A".repeat(64)).slice(0, 43).replace(/[^A-Za-z0-9+/]/g, "A");
}

const MSK = fakeKey("m");
const SSK = fakeKey("s");
const USK = fakeKey("u");

/** 一账号:三把跨签名密钥 + 一台已签设备 + 一台未签设备。 */
function keyQueryBody() {
  return {
    device_keys: {
      [USER]: {
        [MSK]: {
          user_id: USER,
          usage: ["master"],
          keys: { [`ed25519:${MSK}`]: MSK },
          signatures: { [USER]: { [`ed25519:${MSK}`]: "selfsig" } },
          valid_until: 1_800_000_000,
        },
        [SSK]: {
          user_id: USER,
          usage: ["self_signing"],
          keys: { [`ed25519:${SSK}`]: SSK },
          signatures: { [USER]: { [`ed25519:${MSK}`]: "mskSsignsSsk" } },
          valid_until: 1_800_000_000,
        },
        [USK]: {
          user_id: USER,
          usage: ["user_signing"],
          keys: { [`ed25519:${USK}`]: USK },
          signatures: { [USER]: { [`ed25519:${MSK}`]: "mskSignsUsk" } },
          valid_until: 1_800_000_000,
        },
        PICOURIER1: {
          user_id: USER,
          device_id: "PICOURIER1",
          keys: { [`ed25519:PICOURIER1`]: fakeKey("d"), "curve25519:PICOURIER1": fakeKey("c") },
          signatures: { [USER]: { [`ed25519:${SSK}`]: "sskSignsDevice", "ed25519:PICOURIER1": "selfsig" } },
        },
        PLAINDEV: {
          user_id: USER,
          device_id: "PLAINDEV",
          keys: { "ed25519:PLAINDEV": fakeKey("p") },
          signatures: { [USER]: { "ed25519:PLAINDEV": "selfsig" } },
        },
      },
    },
  };
}

describe("canonicalJson", () => {
  it("sorts object keys at every depth and keeps arrays in order", () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 4, c: 3 }] })).toBe('{"a":[2,{"c":3,"d":4}],"b":1}');
  });

  it("drops undefined members, keeps null", () => {
    expect(canonicalJson({ a: undefined, b: null })).toBe('{"b":null}');
  });
});

describe("readKeyQuery", () => {
  it("separates cross-signing keys from devices by the usage field", () => {
    const report = readKeyQuery(USER, keyQueryBody());
    expect(report.hasIdentity).toBe(true);
    expect(report.crossSigning).toHaveLength(3);
    expect(report.devices.map((device) => device.id).sort()).toEqual(["PICOURIER1", "PLAINDEV"]);
  });

  it("marks the device the self-signing key signed, and only that one", () => {
    const report = readKeyQuery(USER, keyQueryBody());
    const signed = report.devices.find((device) => device.id === "PICOURIER1");
    const unsigned = report.devices.find((device) => device.id === "PLAINDEV");
    expect(signed?.signedBySelfSigning).toBe(true);
    expect(unsigned?.signedBySelfSigning).toBe(false);
  });

  it("names the kind of key a signature came from", () => {
    const report = readKeyQuery(USER, keyQueryBody());
    const device = report.devices.find((entry) => entry.id === "PICOURIER1");
    expect(device).toBeDefined();
    expect(signatureSummary(device!, report)).toContain("self_signing");
    expect(signatureSummary(report.devices.find((entry) => entry.id === "PLAINDEV")!, report)).not.toContain("self_signing");
  });

  it("reports no identity for an account that published only devices", () => {
    const report = readKeyQuery(USER, {
      device_keys: { [USER]: { PICOURIER1: { keys: { "ed25519:PICOURIER1": fakeKey("d") }, signatures: {} } } },
    });
    expect(report.hasIdentity).toBe(false);
    expect(report.crossSigning).toEqual([]);
    expect(report.devices).toHaveLength(1);
    expect(report.devices[0].signers).toEqual([]);
  });

  it("reads the validity window of a cross-signing key", () => {
    const report = readKeyQuery(USER, keyQueryBody());
    const master = report.crossSigning.find((key) => key.usage?.includes("master"));
    expect(master?.validUntilMs).toBe(1_800_000_000_000);
  });
});

describe("statusLines", () => {
  it("says something per device, plus the identity and the bundle", () => {
    const report = readKeyQuery(USER, keyQueryBody());
    const bundle = keyBundleStatus(path.join(os.tmpdir(), "pi-courier-verify-nobody-has-this", "cross-signing.json"));
    const lines = statusLines(report, bundle);
    expect(lines).toHaveLength(1 + 3 + 2 + 1);
    expect(lines.join("\n")).toContain(USER);
    expect(lines.join("\n")).toContain("PICOURIER1");
    expect(lines.at(-1)).toContain("cross-signing.json");
  });
});

describe("key bundle files", () => {
  it("writes 0600 and reports it, and flags a loose mode", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-courier-verify-"));
    const bundle = path.join(dir, "cross-signing.json");
    writeKeyBundle(bundle, { master_key: { private: "secret" } });
    expect(keyBundleStatus(bundle)).toMatchObject({ exists: true, mode: "600", worldReadable: false });
    expect(readKeyBundle(bundle)).toEqual({ master_key: { private: "secret" } });
    fs.chmodSync(bundle, 0o644);
    expect(keyBundleStatus(bundle).worldReadable).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reports a missing bundle without throwing", () => {
    const status = keyBundleStatus(path.join(os.tmpdir(), "pi-courier-verify-missing", "cross-signing.json"));
    expect(status).toMatchObject({ exists: false, mode: "", worldReadable: false });
    expect(readKeyBundle(status.path)).toBeNull();
  });
});

describe("ed25519 signing primitives", () => {
  it("round-trips a generated signing key through canonical JSON", () => {
    const { publicKey, privateKey } = generateSigningKey();
    expect(publicKey).toHaveLength(43); // 32 bytes, unpadded base64
    expect(base64Unpadded(Buffer.from("aa"))).toBe("YWE");

    const doc = { user_id: USER, usage: ["master"], keys: { [`ed25519:${publicKey}`]: publicKey } };
    const keyObject = crypto.createPrivateKey({
      key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(privateKey, "base64")]),
      format: "der",
      type: "pkcs8",
    });
    const signature = crypto.sign(null, Buffer.from(canonicalJson(withoutSignatures(doc)), "utf8"), keyObject);
    const signed = { ...doc, signatures: { [USER]: { [`ed25519:${publicKey}`]: base64Unpadded(signature) } } };

    expect(verifyEd25519(publicKey, signed, base64Unpadded(signature))).toBe(true);
    expect(verifyEd25519(publicKey, { ...signed, usage: ["self_signing"] }, base64Unpadded(signature))).toBe(false);
  });
});

describe("fetchKeyReport", () => {
  it("asks whoami, then queries its own user", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      const body = url.endsWith("/whoami") ? { user_id: USER } : keyQueryBody();
      return { ok: true, status: 200, json: async () => body } as Response;
    }) as unknown as typeof fetch;

    const report = await fetchKeyReport({ fetch: fakeFetch, homeserver: "https://hs.example.org", accessToken: "syt_token" });
    expect(calls.map((call) => call.url)).toEqual([
      "https://hs.example.org/_matrix/client/v3/account/whoami",
      "https://hs.example.org/_matrix/client/v3/keys/query",
    ]);
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe("Bearer syt_token");
    expect(report.hasIdentity).toBe(true);
  });

  it("surfaces a server error as an error", async () => {
    const fakeFetch = (async () => ({ ok: false, status: 401, json: async () => ({}) })) as unknown as typeof fetch;
    await expect(fetchKeyReport({ fetch: fakeFetch, homeserver: "https://hs.example.org", accessToken: "nope" })).rejects.toThrow(/401/);
  });
});
