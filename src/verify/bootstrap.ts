/**
 * `pi-courier verify --bootstrap` —— 把「未验证」这道警告真正关掉的那一半
 * (spec:verify-device.md)。
 *
 * 做的是客户端本来就被允许做的事:本地生成三把 cross-signing 密钥(MSK /
 * SSK / USK),MSK 自签,SSK 与 USK 由 MSK 签,上传;然后用 SSK 去签桥自己
 * 那台设备的密钥文档。别人家客户端看到「设备被本账号的 SSK 签过」才算已验证
 * —— 设备自己的自签名只是自证,不是证据。
 *
 * 为什么用不到桥的 crypto store:签名靠这里新生成的密钥;设备私钥只用于服务
 * 端已经存着的那份文档,而那份文档从 /keys/query 原样取回再原样送回去。桥的
 * store 仍由 Rust 绑定独占,命令行不进那扇门。
 *
 * MSC3967 之后「首次上传 cross-signing 密钥」不要求 UIA;真被要求时走
 * m.login.password —— 密码从终端隐藏输入或 0600 文件读入,绝不进命令行参数、
 * 日志与 Matrix 房间。
 *
 * canonical JSON、验签、密钥包落盘都取自 ./cross-signing.js —— 签名的字节规则
 * 只能有一份实现,否则这里签出去的签名没人验得过。
 */
import * as crypto from "node:crypto";
import { t } from "../i18n/index.js";
import {
  base64Unpadded,
  canonicalJson,
  generateSigningKey,
  verifyEd25519,
  withoutSignatures,
  writeKeyBundle,
} from "./cross-signing.js";

const ED25519_PRIVATE_DER_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

/** 一份 cross-signing 密钥的公开文档(上传的就是它)。 */
export interface CrossSigningKeyDoc extends Record<string, unknown> {
  user_id: string;
  usage: string[];
  keys: Record<string, string>;
  signatures?: Record<string, Record<string, string>>;
  valid_from?: string;
  valid_until?: string;
}

/** 能签 JSON 的一把密钥:矩阵密钥 id + 签名动作(私钥不在返回值里)。 */
export interface JsonSigner {
  userId: string;
  /** `ed25519:<公钥>` —— 签名块里引用的就是它。 */
  keyId: string;
  publicKey: string;
  privateKey: string;
}

/**
 * cross-signing 密钥的名字。注意与普通设备不同:设备的密钥 id 是公钥的
 * sha256(spec「Identifying keys」),而 cross-signing 密钥文档里 `keys` 的
 * 名字规定是 `ed25519:` 直接接公钥本身(spec「Cross-signing keys」)。写错了
 * 服务端会收下,但没有任何客户端认它。
 */
export function signingKeyId(publicKeyBase64: string): string {
  return `ed25519:${publicKeyBase64}`;
}

/** 给一份文档加一个签名(同 signer 已有值会被覆盖 —— 只用于新生成的文档)。 */
export function signDocument<T extends Record<string, unknown>>(doc: T, signer: JsonSigner): T {
  const message = Buffer.from(canonicalJson(withoutSignatures(doc)), "utf8");
  const signature = base64Unpadded(
    crypto.sign(null, message, {
      key: Buffer.concat([ED25519_PRIVATE_DER_PREFIX, Buffer.from(signer.privateKey, "base64")]),
      format: "der",
      type: "pkcs8",
    }),
  );
  const signatures = { ...(doc.signatures as Record<string, Record<string, string>> | undefined) };
  signatures[signer.userId] = { ...(signatures[signer.userId] ?? {}), [signer.keyId]: signature };
  return { ...doc, signatures };
}

/** 验一份文档上某个 signer 的签名(自检与测试用)。 */
export function documentIsSigned(doc: Record<string, unknown>, signer: JsonSigner): boolean {
  const signature = ((doc.signatures ?? {}) as Record<string, Record<string, string>>)[signer.userId]?.[signer.keyId];
  return signature ? verifyEd25519(signer.publicKey, doc, signature) : false;
}

/** 新生成一把 cross-signing 密钥(未签名,有效期一年)。 */
export function generateCrossSigningKey(userId: string, usage: "master" | "self_signing" | "user_signing", now = Date.now()): { doc: CrossSigningKeyDoc; signer: JsonSigner } {
  const { publicKey, privateKey } = generateSigningKey();
  const keyId = signingKeyId(publicKey);
  return {
    doc: {
      usage: [usage],
      keys: { [keyId]: publicKey },
      user_id: userId,
      valid_from: new Date(now).toISOString(),
      valid_until: new Date(now + 365 * 24 * 60 * 60 * 1000).toISOString(),
    },
    signer: { userId, keyId, publicKey, privateKey },
  };
}

/** 一个账号的身份包(私钥都在里面 —— 落盘必须 0600)。 */
export interface IdentityBundle {
  userId: string;
  createdAt: string;
  master: { doc: CrossSigningKeyDoc; signer: JsonSigner };
  selfSigning: { doc: CrossSigningKeyDoc; signer: JsonSigner };
  userSigning: { doc: CrossSigningKeyDoc; signer: JsonSigner };
}

/**
 * 组一个身份:MSK 自签(spec 里设备签名那句是「may be signed by a device」,
 * 我们的设备签不了 —— 桥的绑定没有签名入口),SSK 与 USK 由 MSK 签。
 */
export function buildIdentity(userId: string, now = Date.now()): IdentityBundle {
  const master = generateCrossSigningKey(userId, "master", now);
  const selfSigning = generateCrossSigningKey(userId, "self_signing", now);
  const userSigning = generateCrossSigningKey(userId, "user_signing", now);
  return {
    userId,
    createdAt: new Date(now).toISOString(),
    master: { doc: signDocument(master.doc, master.signer), signer: master.signer },
    selfSigning: { doc: signDocument(selfSigning.doc, master.signer), signer: selfSigning.signer },
    userSigning: { doc: signDocument(userSigning.doc, master.signer), signer: userSigning.signer },
  };
}

/** 上传用的三份公开文档(私钥不在里面)。 */
export function identityUploadPayload(bundle: IdentityBundle): Record<string, unknown> {
  return {
    master_key: bundle.master.doc,
    self_signing_key: bundle.selfSigning.doc,
    user_signing_key: bundle.userSigning.doc,
  };
}

/** 密钥包的落盘形状(0600;`verify` 读的就是它)。 */
export function bundleToDisk(bundle: IdentityBundle): Record<string, unknown> {
  const entry = (key: { doc: CrossSigningKeyDoc; signer: JsonSigner }) => ({
    keyId: key.signer.keyId,
    publicKey: key.signer.publicKey,
    privateKey: key.signer.privateKey,
  });
  return { version: 1, userId: bundle.userId, createdAt: bundle.createdAt, master: entry(bundle.master), selfSigning: entry(bundle.selfSigning), userSigning: entry(bundle.userSigning) };
}

/** 写密钥包:目录 700、文件 600、临时文件改名(与 token 同一套纪律)。 */
export function saveKeyBundle(bundlePath: string, bundle: IdentityBundle): void {
  writeKeyBundle(bundlePath, bundleToDisk(bundle));
}

// ---------- 上传 ----------

/** 上传结果:成没成、服务端要不要 UIA、哪个动词成的、以及它的原话。 */
export interface UploadOutcome {
  ok: boolean;
  /** 服务端要求的 UIA 类型(如 `m.login.password`);没要求时为空。 */
  uiaaTypes: string[];
  status: number;
  /** 真正被接受的那个动词(试到第二个才成也要报出来)。 */
  method?: string;
  error?: string;
}

/**
 * `/_matrix/client/v3/keys/device_signing/upload` 的动词顺序。MSC1756 写的是
 * POST,后来的 spec 文本改成了 PUT —— 两个服务端都见过:matrix.enimatek.nl 的
 * Synapse 对 PUT 回 `405 M_UNRECOGNIZED`,对 POST 回 `200 {}`(空体探针实测)。
 * 所以先 POST,认不出来再换 PUT。
 */
export const DEVICE_SIGNING_METHODS = ["POST", "PUT"] as const;

function parseUiaa(body: unknown): { session: string; stages: string[] } | null {
  const value = body as { session?: string; flows?: { stages?: string[] }[] } | null;
  if (!value || typeof value.session !== "string" || !Array.isArray(value.flows)) return null;
  return { session: value.session, stages: value.flows.flatMap((flow) => flow.stages ?? []) };
}

/**
 * 一次带 UIA 的写请求。密码只在真的要它时才用一次,不进返回值、不进日志。
 */
async function uiaaRequest(deps: {
  fetch: typeof fetch;
  url: string;
  method: string;
  accessToken: string;
  userId: string;
  payload: Record<string, unknown>;
  password?: string;
}): Promise<UploadOutcome> {
  const headers = { Authorization: `Bearer ${deps.accessToken}`, "Content-Type": "application/json" };
  const first = await deps.fetch(deps.url, { method: deps.method, headers, body: JSON.stringify(deps.payload) });
  if (first.ok) return { ok: true, uiaaTypes: [], status: first.status };
  const body = (await first.json().catch(() => null)) as Record<string, unknown> | null;
  const prompt = parseUiaa(body);
  if (!prompt) return { ok: false, uiaaTypes: [], status: first.status, error: errorOf(body, first.status) };
  if (!deps.password) return { ok: false, uiaaTypes: prompt.stages, status: first.status };

  const type = prompt.stages.includes("m.login.password") ? "m.login.password" : prompt.stages[0];
  const retry = await deps.fetch(deps.url, {
    method: deps.method,
    headers,
    body: JSON.stringify({
      ...deps.payload,
      auth: { type, session: prompt.session, identifier: { type: "m.id.user", user: deps.userId }, password: deps.password },
    }),
  });
  if (retry.ok) return { ok: true, uiaaTypes: prompt.stages, status: retry.status };
  const again = (await retry.json().catch(() => null)) as Record<string, unknown> | null;
  return { ok: false, uiaaTypes: prompt.stages, status: retry.status, error: errorOf(again, retry.status) };
}

function errorOf(body: Record<string, unknown> | null, status: number): string {
  return String(body?.error ?? t("verify.httpError", { status: String(status) }));
}

/** 上传身份(MSK/SSK/USK)。按 MSC3967,首次上传不需要 UIA。 */
export async function uploadIdentity(deps: {
  fetch: typeof fetch;
  homeserver: string;
  accessToken: string;
  bundle: IdentityBundle;
  password?: string;
  methods?: readonly string[];
}): Promise<UploadOutcome> {
  let last: UploadOutcome | null = null;
  for (const method of deps.methods ?? DEVICE_SIGNING_METHODS) {
    const outcome = await uiaaRequest({
      fetch: deps.fetch,
      url: `${deps.homeserver}/_matrix/client/v3/keys/device_signing/upload`,
      method,
      accessToken: deps.accessToken,
      userId: deps.bundle.userId,
      payload: identityUploadPayload(deps.bundle),
      password: deps.password,
    });
    // 「这个动词我不认」不是失败,是换个动词的理由;其余失败照原样交回去。
    if (outcome.ok) return { ...outcome, method };
    last = { ...outcome, method };
    if (!looksUnrecognized(outcome)) return last;
  }
  return last!;
}

/** 服务端说「这条路/这个动词不存在」—— 405 与 404 都见过。 */
export function looksUnrecognized(outcome: UploadOutcome): boolean {
  if (outcome.status !== 404 && outcome.status !== 405) return false;
  const text = outcome.error ?? "";
  return /unrecognized|unrecognised|M_UNRECOGNIZED|no such (path|route)/i.test(text) || text === "";
}

/**
 * 用 SSK 签一台设备的密钥文档。原文里的自签名保留 —— 服务端把这条当成
 * 「同一台设备,多了一道 SSK 签名」。已经签过就原样返回。
 */
export function signDeviceDoc(deviceDoc: Record<string, unknown>, ssk: JsonSigner, userId: string): Record<string, unknown> {
  const existing = ((deviceDoc.signatures ?? {}) as Record<string, Record<string, string>>)[userId]?.[ssk.keyId];
  if (existing) return deviceDoc;
  return signDocument(deviceDoc, ssk);
}

/** 把设备的 SSK 签名推给服务端(这个端点不要 UIA)。 */
export async function uploadDeviceSignature(deps: {
  fetch: typeof fetch;
  homeserver: string;
  accessToken: string;
  userId: string;
  deviceId: string;
  signedDoc: Record<string, unknown>;
}): Promise<UploadOutcome> {
  const response = await deps.fetch(`${deps.homeserver}/_matrix/client/v3/keys/signatures/upload`, {
    method: "POST",
    headers: { Authorization: `Bearer ${deps.accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ [deps.userId]: { [deps.deviceId]: deps.signedDoc } }),
  });
  if (response.ok) return { ok: true, uiaaTypes: [], status: response.status };
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  return { ok: false, uiaaTypes: [], status: response.status, error: errorOf(body, response.status) };
}

/**
 * 先把 spec 的撞名规则挡在客户端:上传的 cross-signing 公钥不能等于任何已有
 * 设备 id(服务端会 M_FORBIDDEN)。现实里几乎碰不到,但失败要在上传前说。
 */
export function assertNoKeyIdCollision(bundle: IdentityBundle, deviceIds: string[]): void {
  const taken = [bundle.master, bundle.selfSigning, bundle.userSigning]
    .map((key) => key.signer.publicKey)
    .find((publicKey) => deviceIds.includes(publicKey));
  if (taken) throw new Error(t("verify.bootstrap.keyIdCollision", { keyId: taken }));
}

/** 本账号已发布的设备密钥文档原样取回(signatures/upload 要带原文)。 */
export async function fetchOwnDevices(deps: {
  fetch: typeof fetch;
  homeserver: string;
  accessToken: string;
  userId: string;
}): Promise<Record<string, Record<string, unknown>>> {
  const response = await deps.fetch(`${deps.homeserver}/_matrix/client/v3/keys/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${deps.accessToken}`, "Content-Type": "application/json" },
    // 请求体是 {user: [device ids...]} 的映射;空数组 = 全部设备。写成数组
    // 服务端不报错,只是什么都不回 —— 那条坑实测踩过。
    body: JSON.stringify({ device_keys: { [deps.userId]: [] } }),
  });
  const body = (await response.json().catch(() => null)) as { device_keys?: Record<string, Record<string, Record<string, unknown>>> } | null;
  return (body?.device_keys?.[deps.userId] ?? {}) as Record<string, Record<string, unknown>>;
}
