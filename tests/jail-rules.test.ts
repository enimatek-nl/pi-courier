/**
 * Jail rules (spec docs/specs/channel-jail.md).
 *
 * These are the security-relevant decisions of the path guard, so the tests lean
 * on the ways a session actually leaves a directory: traversal, symlink out,
 * `~` expansion, a relative path resolving somewhere unexpected, and the shell
 * shapes that carry a path without looking like one.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  classifyResolved,
  decideToolCall,
  isWritable,
  jailHomeFor,
  pathsInCommand,
  resolveCandidate,
  type JailPolicy
} from "../src/jail/rules.js";

let tmp: string;
let outside: string;
let policy: JailPolicy;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "pi-jail-")));
  outside = join(tmp, "outside");
  for (const dir of ["jail", "home", "agent", "outside"]) mkdirSync(join(tmp, dir), { recursive: true });
  writeFileSync(join(outside, "secret"), "not yours");
  // realpath everywhere: on macOS the temp dir itself is a symlink, and a policy
  // built on unresolved roots would make every assertion below meaningless.
  policy = {
    root: realpathSync(join(tmp, "jail")),
    home: realpathSync(join(tmp, "home")),
    allow: [realpathSync(join(tmp, "agent"))],
    system: ["/etc/resolv.conf", "/usr"]
  };
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("classifyResolved", () => {
  it("allows the jail root and everything below it", () => {
    expect(classifyResolved(join(policy.root, "src/index.ts"), policy).allowed).toBe(true);
    expect(classifyResolved(policy.root, policy).allowed).toBe(true);
  });

  it("allows the jail home and the read-only set", () => {
    expect(classifyResolved(join(policy.home, ".gitconfig"), policy).allowed).toBe(true);
    expect(classifyResolved(join(policy.allow[0]!, "skills/x/SKILL.md"), policy).allowed).toBe(true);
    expect(classifyResolved("/etc/resolv.conf", policy).allowed).toBe(true);
  });

  it("refuses the sensitive half of /etc while keeping what tools need", () => {
    expect(classifyResolved("/etc/resolv.conf", policy).allowed).toBe(true);
    expect(classifyResolved("/etc/ssh/ssh_config", policy).allowed).toBe(false);
    // /proc/<pid>/environ of the bridge holds its access token; the read set does
    // not include /proc at all.
    expect(classifyResolved("/proc/1/environ", policy).allowed).toBe(false);
  });

  it("refuses anything else, naming the path it refused", () => {
    const verdict = classifyResolved(join(outside, "secret"), policy);
    expect(verdict.allowed).toBe(false);
    expect(verdict).toMatchObject({ reason: "outside the jail" });
  });

  it("does not let a sibling prefix count as inside", () => {
    // /tmp/jail-evil is not below /tmp/jail just because the strings share a prefix.
    expect(classifyResolved(`${policy.root}-evil/file`, policy).allowed).toBe(false);
  });
});

describe("isWritable", () => {
  it("writes only where the jail lives", () => {
    expect(isWritable(join(policy.root, "a"), policy)).toBe(true);
    expect(isWritable(join(policy.home, "a"), policy)).toBe(true);
    expect(isWritable(join(policy.allow[0]!, "auth.json"), policy)).toBe(false);
    expect(isWritable("/etc/hosts", policy)).toBe(false);
  });
});

describe("resolveCandidate", () => {
  it("expands ~ against the jail home, never the real home", () => {
    expect(resolveCandidate("~/.ssh/id_ed25519", policy, policy.root)).toBe(join(policy.home, ".ssh/id_ed25519"));
    expect(resolveCandidate("$HOME/.gitconfig", policy, policy.root)).toBe(join(policy.home, ".gitconfig"));
    expect(resolveCandidate("~", policy, policy.root)).toBe(policy.home);
  });

  it("resolves a relative path against the working directory", () => {
    expect(resolveCandidate("src/a.ts", policy, policy.root)).toBe(join(policy.root, "src/a.ts"));
    expect(resolveCandidate("../../etc/passwd", policy, policy.root)).not.toContain(policy.root);
    expect(classifyResolved(resolveCandidate("../../etc/shadow", policy, policy.root), policy).allowed).toBe(false);
  });

  it("follows a symlink out of the jail before deciding", () => {
    const link = join(policy.root, "escape");
    symlinkSync(outside, link);
    const resolved = resolveCandidate(link, policy, policy.root);
    expect(resolved).toBe(realpathSync(outside));
    expect(classifyResolved(resolved, policy).allowed).toBe(false);
  });

  it("resolves as far as a path exists, so writes to new files are still judged", () => {
    const target = resolveCandidate(join(outside, "new/dir/file.ts"), policy, policy.root);
    expect(target).toContain("outside");
    expect(classifyResolved(target, policy).allowed).toBe(false);
  });
});

describe("pathsInCommand", () => {
  it("catches the shapes that carry a path", () => {
    expect(pathsInCommand("cat /etc/passwd")).toContain("/etc/passwd");
    expect(pathsInCommand("cat '~/.ssh/id_rsa'")).toContain("~/.ssh/id_rsa");
    expect(pathsInCommand("git -C ../elsewhere status")).toContain("../elsewhere");
    expect(pathsInCommand("echo hi > /tmp/elsewhere/x")).toContain("/tmp/elsewhere/x");
    expect(pathsInCommand("cd ../../ && ls")).toContain("../../");
  });

  it("does not mistake commands, URLs and remotes for local paths", () => {
    expect(pathsInCommand("echo hello world")).toEqual([]);
    expect(pathsInCommand("curl https://example.com/etc/passwd")).toEqual([]);
    expect(pathsInCommand("git push origin main")).toEqual([]);
    expect(pathsInCommand("scp file.txt user@host:/tmp/x")).toEqual([]);
  });
});

describe("decideToolCall", () => {
  const read = (path: string) => decideToolCall("read", { path }, policy, policy.root, false);

  it("refuses a read outside the jail and allows one inside", () => {
    expect(read(join(outside, "secret")).block).toBeDefined();
    expect(read(join(policy.root, "a.ts")).block).toBeUndefined();
  });

  it("refuses a write into the read-only agent directory", () => {
    const verdict = decideToolCall("write", { path: join(policy.allow[0]!, "extensions/evil.ts") }, policy, policy.root, true);
    expect(verdict.block?.reason).toContain("read-only");
  });

  it("judges a bash command by the paths it names", () => {
    // `~` is the jail's own home, so this reads a file that is not there rather
    // than the operator's key: allowed, and harmless.
    expect(decideToolCall("bash", { command: "cat ~/.ssh/id_ed25519 && echo ok" }, policy, policy.root, false).block).toBeUndefined();
    expect(decideToolCall("bash", { command: 'cat "$HOME/../etc/shadow"' }, policy, policy.root, false).block).toBeDefined();

    const bad = decideToolCall("bash", { command: "cat /root/.ssh/id_ed25519" }, policy, policy.root, false);
    expect(bad.block?.reason).toContain("/root/.ssh/id_ed25519");
  });

  it("scans unknown tools instead of trusting them", () => {
    const verdict = decideToolCall("mcp__files__read", { file_path: "/etc/../root/x", path: outside }, policy, policy.root, false);
    expect(verdict.block).toBeDefined();
  });

  it("lets a tool with no path arguments through", () => {
    expect(decideToolCall("bash", { command: "ls -la" }, policy, policy.root, false).block).toBeUndefined();
  });
});

describe("jailHomeFor", () => {
  it("is stable per room and never inside the jail root", () => {
    const a = jailHomeFor("/state", "!abc:server");
    expect(a).toBe(jailHomeFor("/state", "!abc:server"));
    expect(a).not.toBe(jailHomeFor("/state", "!other:server"));
    expect(a.startsWith("/state/jails/")).toBe(true);
  });
});
