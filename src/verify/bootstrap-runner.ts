/**
 * `pi-courier verify --bootstrap` 的编排层(spec:verify-device.md)。
 *
 * 顺序是固定的,因为每一步都可能停:本地生成 → 自检 → 上传身份 → 签自己的设备
 * → 私钥落盘。自检在上传之前 —— 一把验不过自己公钥的密钥绝不进服务端。
 *
 * 密码只在需要 UIA 时才问,且只活在这一次请求里:不进命令行、不进日志、不进
 * Matrix 房间(桥会把收到的消息原文写进 journald)。
 */
import * as fs from "node:fs";
import { t } from "../i18n/index.js";
import { fetchKeyReport } from "./cross-signing.js";
import {
  assertNoKeyIdCollision,
  buildIdentity,
  documentIsSigned,
  fetchOwnDevices,
  identityUploadPayload,
  saveKeyBundle,
  signDeviceDoc,
  uploadDeviceSignature,
  uploadIdentity,
} from "./bootstrap.js";

export interface BootstrapOptions {
  fetch: typeof fetch;
  homeserver: string;
  accessToken: string;
  bundlePath: string;
  dryRun: boolean;
  force: boolean;
  deviceFilter: string | null;
  passwordFile: string | null;
  /** 覆盖提问方式(测试用)。返回 null 表示用户取消,空串表示「没有密码」。 */
  askSecret?: (prompt: string) => Promise<string | null>;
  log?: (line: string) => void;
  warn?: (line: string) => void;
}

/** 退出码:0 成功;1 有任何一步没成(原因已经打在屏幕上)。 */
export async function runBootstrap(options: BootstrapOptions): Promise<number> {
  const log = options.log ?? ((line) => console.log(line));
  const warn = options.warn ?? ((line) => console.error(line));

  if (fs.existsSync(options.bundlePath) && !options.force) {
    warn(t("verify.bootstrap.bundleExists", { path: options.bundlePath }));
    return 1;
  }

  const report = await fetchKeyReport({ fetch: options.fetch, homeserver: options.homeserver, accessToken: options.accessToken });
  const existing = report.crossSigning.find((key) => (key.usage ?? []).includes("master"));
  if (existing && !options.force) {
    warn(t("verify.bootstrap.identityExists", { keyId: existing.ed25519KeyId }));
    return 1;
  }

  const devices = await fetchOwnDevices({ fetch: options.fetch, homeserver: options.homeserver, accessToken: options.accessToken, userId: report.userId });
  let deviceIds = Object.keys(devices).sort();
  if (options.deviceFilter) {
    if (!deviceIds.includes(options.deviceFilter)) {
      warn(t("verify.bootstrap.noSuchDevice", { deviceId: options.deviceFilter, known: deviceIds.join(", ") || "-" }));
      return 1;
    }
    deviceIds = [options.deviceFilter];
  }
  if (deviceIds.length === 0) {
    warn(t("verify.bootstrap.noDevices"));
    return 1;
  }

  const bundle = buildIdentity(report.userId);
  try {
    assertNoKeyIdCollision(bundle, deviceIds);
  } catch (err) {
    warn(String((err as Error).message));
    return 1;
  }

  // 自检:每份公开文档对签它的那把公钥验一遍。签名规则错在上传之后没人会提醒你。
  const checks: [string, Record<string, unknown>, "master" | "selfSigning" | "userSigning"][] = [
    ["master", bundle.master.doc, "master"],
    ["self_signing", bundle.selfSigning.doc, "master"],
    ["user_signing", bundle.userSigning.doc, "master"],
  ];
  for (const [part, doc, by] of checks) {
    if (!documentIsSigned(doc, bundle[by].signer)) {
      warn(t("verify.bootstrap.selfCheckFailed", { part }));
      return 1;
    }
  }

  log(t("verify.bootstrap.usage", { path: options.bundlePath }));
  log(t("verify.bootstrap.plan", { count: String(deviceIds.length), path: options.bundlePath }));
  if (options.dryRun) {
    log(t("verify.bootstrap.dryRun", { payload: JSON.stringify(identityUploadPayload(bundle), null, 2) }));
    return 0;
  }

  // 先按 MSC3967 直接传:首次上传不要 UIA,不打扰任何人。要了再问密码。
  const request = { fetch: options.fetch, homeserver: options.homeserver, accessToken: options.accessToken, bundle };
  let uploaded = await uploadIdentity(request);
  if (!uploaded.ok && uploaded.uiaaTypes.length > 0) {
    const password = await resolvePassword(options, report.userId);
    if (password === null) {
      warn(t("verify.bootstrap.cancelled"));
      return 1;
    }
    if (!password) {
      warn(t("verify.bootstrap.uiaaNeeded", { types: uploaded.uiaaTypes.join(", ") }));
      return 1;
    }
    uploaded = await uploadIdentity({ ...request, password });
  }
  if (!uploaded.ok) {
    warn(`❌ ${uploaded.error ?? t("verify.httpError", { status: String(uploaded.status) })}`);
    return 1;
  }
  log(t("verify.bootstrap.identityUploaded", { method: uploaded.method ?? "POST" }));

  let signed = 0;
  for (const deviceId of deviceIds) {
    const doc = signDeviceDoc(devices[deviceId], bundle.selfSigning.signer, report.userId);
    const result = await uploadDeviceSignature({
      fetch: options.fetch,
      homeserver: options.homeserver,
      accessToken: options.accessToken,
      userId: report.userId,
      deviceId,
      signedDoc: doc,
    });
    if (result.ok) {
      signed += 1;
      log(t("verify.bootstrap.deviceSigned", { deviceId }));
    } else {
      warn(t("verify.bootstrap.signatureRejected", { deviceId, error: result.error ?? t("verify.httpError", { status: String(result.status) }) }));
    }
  }

  saveKeyBundle(options.bundlePath, bundle);
  log(t("verify.bootstrap.saved", { path: options.bundlePath }));
  if (signed === 0) return 1;
  log(t("verify.bootstrap.backUp"));
  log(t("verify.bootstrap.done", { }));
  return 0;
}

/**
 * 密码来源:文件优先(任何环境都能跑),其次终端隐藏输入。返回 null 只有一
 * 种意思:用户按下了取消 —— 无终端时给空串,让调用方说「需要 UIA,请用
 * --password-file」。
 */
async function resolvePassword(options: BootstrapOptions, userId: string): Promise<string | null> {
  if (options.passwordFile) {
    try {
      return fs.readFileSync(options.passwordFile, "utf8").replace(/\r?\n$/, "");
    } catch {
      console.error(t("verify.bootstrap.passwordFileUnreadable", { path: options.passwordFile }));
      return "";
    }
  }
  const ask = options.askSecret ?? askHiddenLine;
  return await ask(t("verify.bootstrap.passwordPrompt", { userId }));
}

/**
 * 隐藏输入的读一行:raw mode 在每个出口都关掉(包括 Ctrl-C),否则终端比密码
 * 更难收拾。无终端(systemd、管道)时返回 null,由调用方走文件路线。
 */
/**
 * 隐藏输入的读一行。raw mode 在每个出口都关回去 —— 终端留在 raw 模式比密码
 * 泄露更难收拾。无终端(systemd、管道)返回空串「没有密码」;null 只留给
 * Ctrl-C / Esc,那才是取消。
 */
async function askHiddenLine(prompt: string): Promise<string | null> {
  const stdin = process.stdin;
  if (!stdin.isTTY || !stdin.setRawMode) return "";
  process.stdout.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise<string | null>((resolve) => {
    const bytes: number[] = [];
    const done = (value: string | null): void => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
      process.stdout.write("\n");
      resolve(value);
    };
    const onData = (chunk: Buffer): void => {
      for (const byte of chunk) {
        if (byte === 13 || byte === 10) return done(Buffer.from(bytes).toString("utf8"));
        if (byte === 3 || byte === 27) return done(null); // Ctrl-C / Esc
        if (byte === 127 || byte === 8) bytes.pop();
        else bytes.push(byte);
      }
    };
    stdin.on("data", onData);
  });
}

