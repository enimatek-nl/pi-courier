/**
 * `pi-courier verify` —— 「别人到底怎么看我这台设备」的只读视图
 * (spec:verify-device.md)。
 *
 * 做的是一件小事:拿 whoami + POST /keys/query,把「本账号有哪些加密设备、
 * 谁签过它们、账号有没有 cross-signing 身份、本地是否留了密钥包」排成一页,
 * 和 Element 安全页对得上。签名与上传是另一半,spec 里记着实测边界与未决点。
 *
 * 依赖纪律:只用 fetch 与 node:crypto。桥的 crypto store 被 Rust 绑定独占,
 * 而且 0.4 的 schema 新版绑定读不了 —— 任何要碰 store 的动作都必须由桥进程
 * 自己做,命令行这里不进那扇门。
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { t } from "../i18n/index.js";

/** `/keys/query` 返回里的一条密钥:普通设备,或 cross-signing 的三把之一。 */
export interface PublishedKey {
  /**
   * 响应里的键名:普通设备是设备 id,cross-signing 密钥是它的公钥
   * (spec 要求设备 id 不能与 cross-signing 公钥撞名)。
   */
  id: string;
  /** `keys` 里的 ed25519 密钥 id —— 签名块里引用的就是它。 */
  ed25519KeyId: string;
  /** ed25519 公钥(unpadded base64)。 */
  ed25519PublicKey: string;
  /** 签名块里出现的 user id(去重排序)。 */
  signers: string[];
  /** 签名块全文:signer user id → 用到的密钥 id 列表(「谁签的」要能看到哪把钥)。 */
  signedWith: Record<string, string[]>;
  /** 是否被本账号的 self-signing key 签过 —— Element 眼里「已验证」就是这一条。 */
  signedBySelfSigning: boolean;
  /** cross-signing 专用:`usage`(`["master"]` / `["self_signing"]` / `["user_signing"]`)。 */
  usage?: string[];
  /** cross-signing 专用:有效期上限(毫秒)。 */
  validUntilMs?: number;
}

/** 一次 `/keys/query` 的解读结果。 */
export interface KeyReport {
  userId: string;
  /** 本账号的普通加密设备。 */
  devices: PublishedKey[];
  /** 本账号已发布的 cross-signing 密钥(可能为空 —— 那就是「没有身份」)。 */
  crossSigning: PublishedKey[];
  /** 有没有 cross-signing 身份。 */
  hasIdentity: boolean;
}

/** 本地密钥包(`verify --bootstrap` 的落盘产物)的状态。 */
export interface KeyBundleStatus {
  path: string;
  exists: boolean;
  /** 八进制权限字符串(如 `600`);不存在时为空串。 */
  mode: string;
  /** 同组或其他用户可读 —— 密钥包不该这样。 */
  worldReadable: boolean;
}

/** unpadded base64:Matrix 里所有密钥与签名的编码。 */
export function base64Unpadded(buf: Buffer): string {
  return buf.toString("base64").replace(/=+$/g, "");
}

/**
 * Canonical JSON(Matrix 的签名序列化):对象键按码点升序、无多余空白。
 * 签名与验签都必须先过这里,否则同一个对象会有两种字节。
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const parts = Object.entries(value)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, v]) => `${JSON.stringify(key)}:${canonicalJson(v)}`);
  return `{${parts.join(",")}}`;
}

/** 去掉 `signatures` 与 `unsigned` —— 参与签名的那一份。 */
export function withoutSignatures(doc: Record<string, unknown>): Record<string, unknown> {
  const { signatures: _signatures, unsigned: _unsigned, ...rest } = doc;
  return rest;
}

/** 验一枚 ed25519 签名(输入是含签名块的完整对象,内部去掉 signatures/unsigned)。 */
export function verifyEd25519(publicKeyBase64: string, doc: Record<string, unknown>, signatureBase64: string): boolean {
  const key = crypto.createPublicKey({
    key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(publicKeyBase64, "base64")]),
    format: "der",
    type: "spki",
  });
  const message = Buffer.from(canonicalJson(withoutSignatures(doc)), "utf8");
  return crypto.verify(null, message, key, Buffer.from(signatureBase64, "base64"));
}

/** 三把 cross-signing 密钥的名字与上传文档里的字段名,顺序即 MSK → SSK → USK。 */
export const SIGNING_KEY_NAMES = [
  { name: "m.cross_signing.master", usage: "master", field: "master_key" },
  { name: "m.cross_signing.self_signing", usage: "self_signing", field: "self_signing_key" },
  { name: "m.cross_signing.user_signing", usage: "user_signing", field: "user_signing_key" },
] as const;

/**
 * 把 `/keys/query` 里的一条密钥收成摘要。`selfSigningKeyId` 是本账号 SSK 的
 * 密钥 id;签名按 user id 分组,所以查「SSK 有没有签我」要看
 * `signatures[userId][selfSigningKeyId]`。
 */
export function describeKey(userId: string, id: string, raw: Record<string, unknown>, selfSigningKeyId: string | null): PublishedKey {
  const keys = (raw["keys"] ?? {}) as Record<string, string>;
  const ed25519KeyId = Object.keys(keys).find((key) => key.startsWith("ed25519:")) ?? "";
  const signatures = (raw["signatures"] ?? {}) as Record<string, Record<string, unknown>>;
  const usage = Array.isArray(raw["usage"]) ? (raw["usage"] as unknown[]).map(String) : undefined;
  const validUntil = typeof raw["valid_until"] === "number" ? (raw["valid_until"] as number) * 1000 : undefined;
  const signedWith: Record<string, string[]> = {};
  for (const [signer, block] of Object.entries(signatures)) {
    signedWith[signer] = Object.keys(block ?? {}).sort();
  }
  return {
    id,
    ed25519KeyId,
    ed25519PublicKey: keys[ed25519KeyId] ?? "",
    signers: Object.keys(signatures).sort(),
    signedWith,
    signedBySelfSigning: selfSigningKeyId !== null && Boolean(signatures[userId]?.[selfSigningKeyId]),
    ...(usage ? { usage } : {}),
    ...(validUntil !== undefined ? { validUntilMs: validUntil } : {}),
  };
}

/**
 * 解读 `/keys/query` 的响应体。cross-signing 密钥与普通设备混在同一个
 * `device_keys[userId]` 映射里,靠 `usage` 字段区分 —— 普通设备没有它。
 */
export function readKeyQuery(userId: string, body: Record<string, unknown>): KeyReport {
  const users = body["device_keys"] as Record<string, Record<string, Record<string, unknown>>> | undefined;
  const group: Record<string, Record<string, unknown>> = users?.[userId] ?? {};
  const entries = Object.entries(group).filter(([, value]) => value && typeof value === "object");
  const identity = entries.filter(([, value]) => Array.isArray(value["usage"]));
  const ssk = identity.find(([, value]) => (value["usage"] as unknown[]).includes("self_signing"));
  const selfSigningKeyId = ssk ? Object.keys((ssk[1]["keys"] ?? {}) as Record<string, string>)[0] ?? null : null;
  return {
    userId,
    devices: entries
      .filter(([, value]) => !Array.isArray(value["usage"]))
      .map(([id, value]) => describeKey(userId, id, value, selfSigningKeyId)),
    crossSigning: identity.map(([id, value]) => describeKey(userId, id, value, selfSigningKeyId)),
    hasIdentity: identity.length > 0,
  };
}

/**
 * 「谁签的」的人读形式:签名者加上它用的那把钥属于哪类身份。
 * 设备自己签自己不算验证依据,但也要显示出来,否则和 Element 对不上。
 */
export function signatureSummary(key: PublishedKey, report: Pick<KeyReport, "crossSigning">): string {
  const usageByKeyId = new Map<string, string>();
  for (const identity of report.crossSigning) {
    if (identity.ed25519KeyId) usageByKeyId.set(identity.ed25519KeyId, (identity.usage ?? ["?"]).join("+"));
  }
  const parts: string[] = [];
  for (const signer of key.signers) {
    const kinds = (key.signedWith[signer] ?? [])
      .map((keyId) => usageByKeyId.get(keyId))
      .filter((kind): kind is string => kind !== undefined);
    parts.push(kinds.length > 0 ? `${signer} (${kinds.join("+")})` : signer);
  }
  return parts.length > 0 ? parts.join(", ") : t("verify.status.noSigners");
}

/** 本地密钥包的状态:在不在、权限如何、别人能不能读。 */
export function keyBundleStatus(bundlePath: string): KeyBundleStatus {
  let mode = "";
  try {
    mode = (fs.statSync(bundlePath).mode & 0o777).toString(8).padStart(3, "0");
  } catch {
    mode = "";
  }
  return {
    path: bundlePath,
    exists: mode !== "",
    mode,
    worldReadable: mode !== "" && (parseInt(mode, 8) & 0o077) !== 0,
  };
}

/** 原子写密钥包:目录 700、文件 600,先临时文件再 rename。 */
export function writeKeyBundle(bundlePath: string, bundle: unknown): void {
  fs.mkdirSync(path.dirname(bundlePath), { recursive: true, mode: 0o700 });
  const temp = `${bundlePath}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(bundle, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, bundlePath);
  fs.chmodSync(bundlePath, 0o600);
}

/** 读密钥包;不存在或读不动返回 null(调用方决定是警告还是停下)。 */
export function readKeyBundle(bundlePath: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(bundlePath, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** 生成一把 cross-signing 用的 ed25519 密钥(公私钥都是 unpadded base64)。 */
export function generateSigningKey(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const rawPublic = publicKey.export({ type: "spki", format: "der" }).subarray(-32);
  const rawPrivate = privateKey.export({ type: "pkcs8", format: "der" }).subarray(-32);
  return { publicKey: base64Unpadded(rawPublic), privateKey: base64Unpadded(rawPrivate) };
}

/** 状态一页纸的正文(不含标题);逐行返回,好测。 */
export function statusLines(report: KeyReport, bundle: KeyBundleStatus): string[] {
  const lines: string[] = [t("verify.status.user", { userId: report.userId })];
  if (!report.hasIdentity) {
    lines.push(t("verify.status.noIdentity"));
  }
  for (const identity of report.crossSigning) {
    lines.push(
      t("verify.status.identityLine", {
        usage: (identity.usage ?? ["?"]).join("+"),
        keyId: identity.ed25519KeyId,
        validUntil: identity.validUntilMs ? new Date(identity.validUntilMs).toISOString().slice(0, 10) : "?",
      }),
    );
  }
  for (const device of report.devices) {
    lines.push(
      t(device.signedBySelfSigning ? "verify.status.deviceSigned" : "verify.status.deviceUnsigned", {
        deviceId: device.id,
        signers: signatureSummary(device, report),
      }),
    );
  }
  lines.push(
    bundle.exists
      ? t(bundle.worldReadable ? "verify.status.bundleWorldReadable" : "verify.status.bundlePresent", {
          path: bundle.path,
          mode: bundle.mode,
        })
      : t("verify.status.bundleMissing", { path: bundle.path }),
  );
  return lines;
}

/**
 * 取一次数:whoami 认出自己的 user id,再 keys/query 把自己账号的密钥全捞回
 * 来。fetch 由调用方注入 —— 命令行给真的,测试给假的(doctor 同一手法)。
 */
export async function fetchKeyReport(deps: { fetch: typeof fetch; homeserver: string; accessToken: string }): Promise<KeyReport> {
  const headers = { Authorization: `Bearer ${deps.accessToken}` };
  const whoami = await deps.fetch(`${deps.homeserver}/_matrix/client/v3/account/whoami`, { headers });
  if (!whoami.ok) throw new Error(`whoami → ${whoami.status}`);
  const identity = (await whoami.json()) as { user_id?: string };
  const userId = typeof identity.user_id === "string" ? identity.user_id : "";
  if (!userId) throw new Error("whoami answered without a user_id");

  const query = await deps.fetch(`${deps.homeserver}/_matrix/client/v3/keys/query`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ device_keys: { [userId]: [] } }),
  });
  if (!query.ok) throw new Error(`keys/query → ${query.status}`);
  return readKeyQuery(userId, (await query.json()) as Record<string, unknown>);
}
