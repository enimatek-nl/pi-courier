/**
 * `verify --bootstrap` 的写的那一半(spec:verify-device.md)。
 *
 * 全部离线:fetch 是假的,服务端只存在于测试的路由里;落盘写到临时目录。
 * 有一条测试是不可省的:任何一条路径都不把密码与私钥写进输出。
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { setLocale } from "../src/i18n/index.js";
import {
  assertNoKeyIdCollision,
  buildIdentity,
  bundleToDisk,
  documentIsSigned,
  fetchOwnDevices,
  generateCrossSigningKey,
  identityUploadPayload,
  saveKeyBundle,
  signDeviceDoc,
  signingKeyId,
  uploadDeviceSignature,
  uploadIdentity,
  type JsonSigner,
} from "../src/verify/bootstrap.js";
import { runBootstrap, runSignDevices } from "../src/verify/bootstrap-runner.js";
import { unknownVerifyFlags, positionalAfterSign } from "../src/verify/cli-flags.js";
import { verifyEd25519 } from "../src/verify/cross-signing.js";

setLocale("en");

const USER = "@pico:example.org";
const HS = "https://hs.example.org";
const TOKEN = "s3cr3t-tok3n";

/** 43 字符的假 ed25519 公钥(形状对即可,不参与验签)。 */
function fakeKey(seed: string): string {
  return crypto.createHash("sha256").update(seed).digest("base64").replace(/=+$/g, "").slice(0, 43);
}

/** 一账号一台设备的 /keys/query 响应;`withIdentity` 加上三把跨签名密钥。 */
function keyQueryBody(deviceIds = ["PICOURIERDEVAAAAAA"], withIdentity = false) {
  const account: Record<string, unknown> = {};
  for (const deviceId of deviceIds) {
    const ed25519 = fakeKey(deviceId);
    account[deviceId] = {
      user_id: USER,
      device_id: deviceId,
      algorithms: ["m.olm.v1.curve25519-aes-sha2", "m.megolm.v1.aes-sha2"],
      keys: { [`ed25519:${ed25519}`]: ed25519, [`curve25519:${fakeKey(`c${deviceId}`)}`]: fakeKey(`c${deviceId}`) },
      signatures: { [USER]: { [`ed25519:${ed25519}`]: `self-sig-${deviceId}` } },
    };
  }
  if (withIdentity) {
    const master = fakeKey("master");
    account[master] = { user_id: USER, usage: ["master"], keys: { [`ed25519:${master}`]: master }, signatures: {} };
  }
  return { device_keys: { [USER]: account } };
}

interface Call {
  url: string;
  method?: string;
  body?: Record<string, unknown>;
}

/**
 * 假服务端:记录每次调用,按 url 尾巴决定回什么。`uiaa` 让写请求先要一次
 * user-interactive auth,`rejectSignatures` 让签名上传被拒。
 */
function makeFetch(scenario: { uiaa?: boolean; signatureStatus?: number; deviceIds?: string[]; withIdentity?: boolean; signingStatusByMethod?: Record<string, number>; signDevicesWith?: string } = {}) {
  const calls: Call[] = [];
  const fetchStub = (async (url: string, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    calls.push({ url: String(url), method: init?.method, body });
    const respond = (status: number, payload: unknown) =>
      ({ ok: status >= 200 && status < 300, status, json: async () => payload }) as unknown as Response;

    if (String(url).endsWith("/account/whoami")) return respond(200, { user_id: USER });
    if (String(url).endsWith("/keys/query")) {
      const body2 = keyQueryBody(scenario.deviceIds ?? ["PICOURIERDEVAAAAAA"], scenario.withIdentity) as { device_keys: Record<string, Record<string, Record<string, unknown>>> };
      if (scenario.signDevicesWith) {
        for (const doc of Object.values(body2.device_keys[USER])) {
          const signatures = doc.signatures as Record<string, Record<string, string>>;
          signatures[USER][scenario.signDevicesWith] = "already";
        }
      }
      return respond(200, body2);
    }
    if (String(url).endsWith("/keys/device_signing/upload")) {
      const forced = scenario.signingStatusByMethod?.[(init?.method ?? "GET").toUpperCase()];
      if (forced && forced >= 300) {
        return respond(forced, { errcode: "M_UNRECOGNIZED", error: "Unrecognized request" });
      }
      if (scenario.uiaa && !body?.auth) {
        return respond(401, { errcode: "M_UNAUTHORIZED", session: "session-1", flows: [{ stages: ["m.login.password"] }] });
      }
      return respond(200, {});
    }
    if (String(url).endsWith("/keys/signatures/upload")) {
      const status = scenario.signatureStatus ?? 200;
      return respond(status, status === 200 ? { error: null } : { errcode: "M_INVALID_SIGNATURE", error: "signature does not verify" });
    }
    return respond(404, { errcode: "M_UNRECOGNIZED", error: "no such endpoint" });
  }) as unknown as typeof fetch;
  return { fetchStub, calls };
}

function tmpBundle(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pico-bundle-")), "cross-signing.json");
}

function runOptions(overrides: Partial<Parameters<typeof runBootstrap>[0]>) {
  const logs: string[] = [];
  const warns: string[] = [];
  const options = {
    homeserver: HS,
    accessToken: TOKEN,
    bundlePath: tmpBundle(),
    dryRun: false,
    force: false,
    deviceFilter: null,
    passwordFile: null,
    askSecret: async () => "",
    log: (line: string) => logs.push(line),
    warn: (line: string) => warns.push(line),
    ...overrides,
  };
  return { options, logs, warns };
}

describe("signingKeyId / signDocument", () => {
  it("cross-signing 密钥的名字是 ed25519: 接公钥本身(不是 sha256)", () => {
    const publicKey = fakeKey("identity");
    expect(signingKeyId(publicKey)).toBe(`ed25519:${publicKey}`);
    const { doc } = generateCrossSigningKey(USER, "master");
    expect(Object.keys(doc.keys)).toEqual([`ed25519:${Object.values(doc.keys)[0]}`]);
  });

  it("签出去的文档对自己的公钥验得过", () => {
    const { signer } = generateCrossSigningKey(USER, "master");
    const doc = generateCrossSigningKey(USER, "self_signing").doc;
    const signed = signDeviceDocForTest(doc, signer);
    expect(documentIsSigned(signed, signer)).toBe(true);
  });

  it("改一个字节签名就废", () => {
    const bundle = identityBundle();
    const signed = bundle.master.doc;
    expect(documentIsSigned(signed, bundle.master.signer)).toBe(true);
    expect(documentIsSigned({ ...signed, usage: ["master", "extra"] }, bundle.master.signer)).toBe(false);
    expect(documentIsSigned(generateCrossSigningKey(USER, "master").doc, bundle.master.signer)).toBe(false);
  });
});

function identityBundle(): ReturnType<typeof buildIdentity> {
  return buildIdentity(USER, Date.parse("2026-11-23T00:00:00.000Z"));
}

function signDeviceDocForTest(doc: Record<string, unknown>, signer: JsonSigner): Record<string, unknown> {
  return signDeviceDoc(doc, signer, USER);
}

describe("buildIdentity / 落盘", () => {
  it("MSK 自签,SSK 与 USK 由 MSK 签", () => {
    const bundle = identityBundle();
    expect(documentIsSigned(bundle.master.doc, bundle.master.signer)).toBe(true);
    expect(documentIsSigned(bundle.selfSigning.doc, bundle.master.signer)).toBe(true);
    expect(documentIsSigned(bundle.userSigning.doc, bundle.master.signer)).toBe(true);
    expect(documentIsSigned(bundle.selfSigning.doc, bundle.selfSigning.signer)).toBe(false);
  });

  it("上传负载里没有私钥", () => {
    const bundle = identityBundle();
    const payload = JSON.stringify(identityUploadPayload(bundle));
    for (const key of [bundle.master, bundle.selfSigning, bundle.userSigning]) {
      expect(payload).not.toContain(key.signer.privateKey);
    }
    expect(Object.keys(JSON.parse(payload)).sort()).toEqual(["master_key", "self_signing_key", "user_signing_key"]);
  });

  it("密钥包 0600,读回来还是同一个 userId", () => {
    const file = tmpBundle();
    const bundle = identityBundle();
    saveKeyBundle(file, bundle);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const onDisk = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    expect(onDisk.userId).toBe(USER);
    expect((onDisk.master as Record<string, unknown>).privateKey).toBe(bundle.master.signer.privateKey);
    expect(bundleToDisk(bundle).version).toBe(1);
  });

  it("cross-signing 公钥与已有设备 id 撞名时先挡住", () => {
    const bundle = identityBundle();
    const collision = bundle.selfSigning.signer.publicKey;
    expect(bundle.userId).toBe(USER);
    expect(() => assertNoKeyIdCollision(bundle, ["OTHER", collision])).toThrow(/collides/);
    expect(() => assertNoKeyIdCollision(bundle, ["OTHER"])).not.toThrow();
  });
});

describe("uploadIdentity", () => {
  it("首次上传不要 UIA:一次 POST,三份文档都带上", async () => {
    const { fetchStub, calls } = makeFetch();
    const outcome = await uploadIdentity({ fetch: fetchStub, homeserver: HS, accessToken: TOKEN, bundle: identityBundle() });
    expect(outcome.ok).toBe(true);
    expect(outcome.method).toBe("POST");
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST");
    expect(Object.keys(calls[0].body ?? {}).sort()).toEqual(["master_key", "self_signing_key", "user_signing_key"]);
    expect(JSON.stringify(outcome)).not.toContain("privateKey");
  });

  it("被要求 UIA 时带密码重发,而密码不出现在结果里", async () => {
    const { fetchStub, calls } = makeFetch({ uiaa: true });
    const outcome = await uploadIdentity({ fetch: fetchStub, homeserver: HS, accessToken: TOKEN, bundle: identityBundle(), password: "correct-horse" });
    expect(outcome.ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[0].body?.auth).toBeUndefined();
    const auth = calls[1].body?.auth as Record<string, string>;
    expect(auth.type).toBe("m.login.password");
    expect(auth.session).toBe("session-1");
    expect(auth.password).toBe("correct-horse");
    expect(JSON.stringify(outcome)).not.toContain("correct-horse");
  });

  it("没有密码就停下,把服务端要的类型交回去", async () => {
    const { fetchStub, calls } = makeFetch({ uiaa: true });
    const outcome = await uploadIdentity({ fetch: fetchStub, homeserver: HS, accessToken: TOKEN, bundle: identityBundle() });
    expect(outcome.ok).toBe(false);
    expect(outcome.uiaaTypes).toEqual(["m.login.password"]);
    expect(calls).toHaveLength(1);
  });

  it("这个 Synapse 只认 POST:PUT 405 就换过去,别的方法不试", async () => {
    const onlyPost = makeFetch();
    const postFirst = await uploadIdentity({ fetch: onlyPost.fetchStub, homeserver: HS, accessToken: TOKEN, bundle: identityBundle() });
    expect(postFirst.method).toBe("POST");

    // 先试的动词被服务端否认时,第二个要顶上
    const { fetchStub, calls } = makeFetch({ signingStatusByMethod: { POST: 405 } });
    const outcome = await uploadIdentity({ fetch: fetchStub, homeserver: HS, accessToken: TOKEN, bundle: identityBundle() });
    expect(outcome.ok).toBe(true);
    expect(outcome.method).toBe("PUT");
    expect(calls.map((call) => call.method)).toEqual(["POST", "PUT"]);
  });

  it("两个动词都不认时把最后一次失败交回去,不再乱试", async () => {
    const { fetchStub, calls } = makeFetch({ signingStatusByMethod: { POST: 405, PUT: 404 } });
    const outcome = await uploadIdentity({ fetch: fetchStub, homeserver: HS, accessToken: TOKEN, bundle: identityBundle() });
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain("Unrecognized");
    expect(calls.map((call) => call.method)).toEqual(["POST", "PUT"]);
  });
});

describe("设备签名", () => {
  it("取回原文 → 加 SSK 签名 → 自签名还在,而且幂等", () => {
    const bundle = identityBundle();
    const original = keyQueryBody().device_keys[USER].PICOURIERDEVAAAAAA as Record<string, unknown>;
    const signed = signDeviceDoc(original, bundle.selfSigning.signer, USER);
    const signatures = (signed.signatures as Record<string, Record<string, string>>)[USER];
    expect(signatures[`ed25519:${bundle.selfSigning.signer.publicKey}`]).toBeTruthy();
    expect(signatures["ed25519:self"]).toBeUndefined();
    expect(Object.keys(signatures)).toHaveLength(2);
    expect(signDeviceDoc(signed, bundle.selfSigning.signer, USER)).toBe(signed);
  });

  it("签名上传的体是 {user: {device: doc}};服务端拒绝时把原话交回去", async () => {
    const bundle = identityBundle();
    const doc = signDeviceDoc(keyQueryBody().device_keys[USER].PICOURIERDEVAAAAAA as Record<string, unknown>, bundle.selfSigning.signer, USER);
    const ok = makeFetch();
    const good = await uploadDeviceSignature({ fetch: ok.fetchStub, homeserver: HS, accessToken: TOKEN, userId: USER, deviceId: "PICOURIERDEVAAAAAA", signedDoc: doc });
    expect(good.ok).toBe(true);
    const pushed = ok.calls[0].body as Record<string, Record<string, Record<string, unknown>>>;
    expect(pushed[USER].PICOURIERDEVAAAAAA.device_id).toBe("PICOURIERDEVAAAAAA");

    const bad = makeFetch({ signatureStatus: 400 });
    const rejected = await uploadDeviceSignature({ fetch: bad.fetchStub, homeserver: HS, accessToken: TOKEN, userId: USER, deviceId: "PICOURIERDEVAAAAAA", signedDoc: doc });
    expect(rejected.ok).toBe(false);
    expect(rejected.error).toContain("signature does not verify");
  });

  it("fetchOwnDevices 只取本账号那一份,且用映射形式的请求体", async () => {
    const { fetchStub, calls } = makeFetch();
    const devices = await fetchOwnDevices({ fetch: fetchStub, homeserver: HS, accessToken: TOKEN, userId: USER });
    expect(Object.keys(devices)).toEqual(["PICOURIERDEVAAAAAA"]);
    // 请求体写成数组服务端不报错,只是什么都不回 —— 形状必须钉住。
    expect(calls[calls.length - 1].body).toEqual({ device_keys: { [USER]: [] } });
  });
});

describe("runBootstrap", () => {
  it("--dry-run 不写任何东西,也不上传", async () => {
    const { fetchStub, calls } = makeFetch();
    const { options, logs } = runOptions({ fetch: fetchStub });
    const code = await runBootstrap({ ...options, dryRun: true });
    expect(code).toBe(0);
    expect(calls.some((call) => String(call.url).includes("device_signing/upload") || String(call.url).includes("signatures/upload"))).toBe(false);
    expect(fs.existsSync(options.bundlePath)).toBe(false);
    expect(logs.join("\n")).toContain("master_key");
  });

  it("完整跑一遍:上传身份、签每台设备、密钥落盘", async () => {
    const { fetchStub, calls } = makeFetch();
    const { options, logs } = runOptions({ fetch: fetchStub });
    const code = await runBootstrap(options);
    expect(code).toBe(0);
    expect(calls.some((call) => call.method === "POST" && String(call.url).endsWith("device_signing/upload"))).toBe(true);
    const signed = calls.filter((call) => String(call.url).endsWith("signatures/upload"));
    expect(signed).toHaveLength(1);
    expect(fs.existsSync(options.bundlePath)).toBe(true);
    expect(fs.statSync(options.bundlePath).mode & 0o777).toBe(0o600);
    expect(logs.join("\n")).toContain("PICOURIERDEVAAAAAA");
  });

  it("已有密钥包时拒绝,--force 才继续", async () => {
    const first = makeFetch();
    const a = runOptions({ fetch: first.fetchStub });
    expect(await runBootstrap(a.options)).toBe(0);

    const second = makeFetch();
    const b = runOptions({ fetch: second.fetchStub, bundlePath: a.options.bundlePath });
    expect(await runBootstrap(b.options)).toBe(1);
    expect(second.calls.some((call) => String(call.url).includes("device_signing/upload"))).toBe(false);

    const c = runOptions({ fetch: second.fetchStub, bundlePath: a.options.bundlePath, force: true });
    expect(await runBootstrap(c.options)).toBe(0);
  });

  it("账号已有 cross-signing 身份时拒绝(不重置别人的信任)", async () => {
    const { fetchStub, calls } = makeFetch({ withIdentity: true });
    const { options, warns } = runOptions({ fetch: fetchStub });
    expect(await runBootstrap(options)).toBe(1);
    expect(calls.some((call) => String(call.url).includes("device_signing/upload"))).toBe(false);
    expect(warns.join("\n")).toContain("already has a cross-signing identity");
  });

  it("服务端要 UIA 而无处取密码时,把可用类型说清楚", async () => {
    const { fetchStub, calls } = makeFetch({ uiaa: true });
    const { options, warns } = runOptions({ fetch: fetchStub, askSecret: async () => "" });
    expect(await runBootstrap(options)).toBe(1);
    expect(warns.join("\n")).toContain("m.login.password");
    expect(fs.existsSync(options.bundlePath)).toBe(false);
    // 一次 POST 撞上 401,没有密码就不再试第二次
    expect(calls.filter((call) => String(call.url).includes("device_signing/upload"))).toHaveLength(1);
  });

  it("密码文件能用,而且密码不落进任何输出", async () => {
    const secret = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pico-secret-")), "pw");
    fs.writeFileSync(secret, "correct-horse\n", { mode: 0o600 });
    const { fetchStub } = makeFetch({ uiaa: true });
    const { options, logs, warns } = runOptions({ fetch: fetchStub, passwordFile: secret });
    const code = await runBootstrap(options);
    expect(code).toBe(0);
    expect([...logs, ...warns].join("\n")).not.toContain("correct-horse");
  });

  it("终端按下取消就不再试第二次", async () => {
    const { fetchStub, calls } = makeFetch({ uiaa: true });
    const { options, warns } = runOptions({ fetch: fetchStub, askSecret: async () => null });
    expect(await runBootstrap(options)).toBe(1);
    expect(calls.filter((call) => String(call.url).includes("device_signing/upload"))).toHaveLength(1); // 只有那次 401
    expect(warns.join("\n")).toContain("Cancelled");
    expect(fs.existsSync(options.bundlePath)).toBe(false);
  });

  it("--device 指定不存在的设备时先说清楚", async () => {
    const { fetchStub, calls } = makeFetch();
    const { options, warns } = runOptions({ fetch: fetchStub, deviceFilter: "NOPE" });
    expect(await runBootstrap(options)).toBe(1);
    expect(warns.join("\n")).toContain("NOPE");
    expect(calls.some((call) => String(call.url).includes("device_signing/upload"))).toBe(false);
  });

  it("身份传上去但设备签名被拒:算失败,密钥包仍留下(身份已经生效)", async () => {
    const { fetchStub } = makeFetch({ signatureStatus: 400 });
    const { options, warns } = runOptions({ fetch: fetchStub });
    expect(await runBootstrap(options)).toBe(1);
    expect(warns.join("\n")).toContain("signature does not verify");
    expect(fs.existsSync(options.bundlePath)).toBe(true);
  });
});

describe("runSignDevices", () => {
  /** 密钥包写在临时目录里,签的时候应从盘上用,而不是再生一把。 */
  function bundleOnDisk(): { path: string; publicKey: string; keyId: string } {
    const bundle = identityBundle();
    const file = tmpBundle();
    saveKeyBundle(file, bundle);
    return { path: file, publicKey: bundle.selfSigning.signer.publicKey, keyId: bundle.selfSigning.signer.keyId };
  }

  it("签掉没签的设备,而且用的就是盘上那把 self-signing key", async () => {
    const onDisk = bundleOnDisk();
    const { fetchStub, calls } = makeFetch();
    const { options, logs } = runOptions({ fetch: fetchStub, bundlePath: onDisk.path });
    const code = await runSignDevices({ fetch: fetchStub, homeserver: HS, accessToken: TOKEN, bundlePath: onDisk.path, deviceIds: [], log: (line) => logs.push(line) });
    expect(code).toBe(0);
    void options;
    const pushed = calls.filter((call) => String(call.url).endsWith("signatures/upload"));
    expect(pushed).toHaveLength(1);
    const body = pushed[0].body as Record<string, Record<string, Record<string, Record<string, string>>>>;
    const doc = body[USER].PICOURIERDEVAAAAAA;
    const signature = doc.signatures[USER][onDisk.keyId];
    expect(signature).toBeTruthy();
    expect(verifyEd25519(onDisk.publicKey, doc as unknown as Record<string, unknown>, signature)).toBe(true);
  });

  it("已经签过的设备不再推一次", async () => {
    const onDisk = bundleOnDisk();
    const { fetchStub, calls } = makeFetch({ signDevicesWith: onDisk.keyId });
    const code = await runSignDevices({ fetch: fetchStub, homeserver: HS, accessToken: TOKEN, bundlePath: onDisk.path, deviceIds: [] });
    expect(code).toBe(0);
    expect(calls.filter((call) => String(call.url).endsWith("signatures/upload"))).toHaveLength(0);
  });

  it("没有密钥包时停下,并指向 bootstrap", async () => {
    const { fetchStub, calls } = makeFetch();
    const warns: string[] = [];
    const code = await runSignDevices({ fetch: fetchStub, homeserver: HS, accessToken: TOKEN, bundlePath: tmpBundle(), deviceIds: [], warn: (line) => warns.push(line) });
    expect(code).toBe(1);
    expect(warns.join("\n")).toContain("--bootstrap");
    expect(calls.filter((call) => String(call.url).endsWith("signatures/upload"))).toHaveLength(0);
  });

  it("指定不存在的设备就不动手", async () => {
    const onDisk = bundleOnDisk();
    const { fetchStub, calls } = makeFetch();
    const warns: string[] = [];
    const code = await runSignDevices({ fetch: fetchStub, homeserver: HS, accessToken: TOKEN, bundlePath: onDisk.path, deviceIds: ["NOPE"], warn: (line) => warns.push(line) });
    expect(code).toBe(1);
    expect(warns.join("\n")).toContain("NOPE");
    expect(calls.filter((call) => String(call.url).endsWith("signatures/upload"))).toHaveLength(0);
  });
});

describe("verify 的参数判定", () => {
  it("不认识的选项要报出来", () => {
    expect(unknownVerifyFlags(["--json"])).toBeNull();
    expect(unknownVerifyFlags(["--bootstrap", "--dry-run", "--device", "X", "--password-file=/p"])).toBeNull();
    expect(unknownVerifyFlags(["--sig"])).toBe("--sig");
  });

  it("--sign 后面的设备 id 收走,后面的选项留下", () => {
    expect(positionalAfterSign(["--sign"])).toEqual([]);
    expect(positionalAfterSign(["--sign", "ABCD", "EFGH", "--json"])).toEqual(["ABCD", "EFGH"]);
    expect(positionalAfterSign(["--json"])).toEqual([]);
  });
});
