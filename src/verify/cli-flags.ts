/**
 * `pi-courier verify` 的参数判定(spec:verify-device.md)。
 *
 * 单拎出来只为一条理由:cli.ts 一被 import 就跑 main(),测试进不去。而被静默
 * 忽略的选项比报错更坏 —— 有人敲 `--sign` 时它还只是「读一遍报告」,看上去
 * 像是执行了签名 —— 所以不认识的就停下,并把可用的列出来。
 */

/** `verify` 认的开关。 */
const VERIFY_FLAGS = new Set(["--json", "--bootstrap", "--dry-run", "--force", "--sign"]);
/** `verify` 认的、带值的选项。 */
const VERIFY_VALUE_FLAGS = new Set(["--device", "--password-file"]);

/** 第一个不认识的 `--…`;全都认识时为 null。 */
export function unknownVerifyFlags(args: string[]): string | null {
  for (const arg of args) {
    if (!arg.startsWith("--")) continue;
    const name = arg.split("=")[0];
    if (VERIFY_FLAGS.has(name) || VERIFY_VALUE_FLAGS.has(name)) continue;
    return arg;
  }
  return null;
}

/** `--sign` 后面的设备 id 列表(碰到下一个 `--…` 为止)。 */
export function positionalAfterSign(args: string[]): string[] {
  const index = args.indexOf("--sign");
  if (index < 0) return [];
  const rest: string[] = [];
  for (const arg of args.slice(index + 1)) {
    if (arg.startsWith("--")) break;
    rest.push(arg);
  }
  return rest;
}
