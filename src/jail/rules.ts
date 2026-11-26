/**
 * Jail rules — the deciding logic behind the path guard
 * (docs/specs/channel-jail.md).
 *
 * The guard itself is a pi extension (guard.ts); everything with a judgement in
 * it lives here, as pure functions over strings. Two reasons: a security rule
 * you cannot test in isolation is a rule you cannot trust, and the interesting
 * cases (`..`, `~`, a symlink pointing out of the jail, `git -C ../elsewhere`)
 * need no pi process to pin down.
 *
 * What a verdict means, and what it does not: refusing a tool call keeps that
 * tool call from running. It is not an operating-system boundary — a process
 * that runs a command we failed to recognise can still reach the path. The
 * boundary is the container; this is the fence that stops the accident, the
 * confused guest and the hijacked prompt.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export interface JailPolicy {
  /** The one directory the session may read and write. */
  root: string;
  /** The jail's own home (`$HOME` inside), read-write. Kept outside the root on
   *  purpose: if the session could write its own `~/.ssh/config` or
   *  `~/.gitconfig`, the rules below would be evaluated against a home the
   *  confined party controls. */
  home: string;
  /** Read-only exceptions — the pi agent directory (settings, skills,
   *  AGENTS.md, auth.json) and any configured resource roots. Read-only is the
   *  whole point: the agent directory is also where extensions and credentials
   *  live, so a writable one would let a jailed session install code the host
   *  pi loads later. */
  allow: string[];
  /** Read-only system paths tools fall apart without (name resolution,
   *  certificates, /dev/null). Writes there are refused. */
  system: string[];
}

export type Verdict = { allowed: true } | { allowed: false; path: string; reason: string };

/**
 * Read-only system paths, kept as narrow as the tools need rather than as broad
 * as `/etc` happens to be.
 *
 * Tools break without name resolution, certificates and `/dev/null`, so those
 * are in. The whole of `/etc` is not: it also holds `ssh/ssh_config`, and a
 * directory of other people's configuration is recon, not a dependency. `/proc`
 * and `/sys` are out for the same reason in the other direction — a same-user
 * process can read `/proc/<pid>/environ`, and the bridge's environment is exactly
 * where its access token lives.
 */
export const SYSTEM_READ_PATHS = [
  "/usr",
  "/bin",
  "/sbin",
  "/lib",
  "/lib64",
  "/opt",
  "/dev",
  "/etc/resolv.conf",
  "/etc/hosts",
  "/etc/nsswitch.conf",
  "/etc/passwd",
  "/etc/group",
  "/etc/protocols",
  "/etc/services",
  "/etc/localtime",
  "/etc/timezone",
  "/etc/mime.types",
  "/etc/ssl",
  "/etc/pki",
  "/etc/ca-certificates",
  "/etc/fonts",
  "/usr/share/ca-certificates"
];

/** The default `HOME` a jail gets: below the bridge's own state directory, so
 *  it is neither the real home nor inside the session's writable root. */
export function jailHomeFor(stateDir: string, roomId: string): string {
  const key = roomId.replace(/[^A-Za-z0-9]/g, "").slice(0, 24) || "room";
  return path.join(stateDir, "jails", key, "home");
}

/**
 * Resolve a candidate path to an absolute one without following it into
 * nonexistence.
 *
 * `~` expands against the JAIL's home, not the caller's: a model that writes
 * `~/.ssh/id_rsa` inside a jail is asking for a file that does not exist there,
 * and it is more honest to let it miss than to hand it the real key. Relative
 * paths resolve against the working directory the tool call would run in.
 *
 * The real-path step is the one that matters for safety: `realpath` stops a
 * symlink inside the jail from naming a file outside it. A path that does not
 * exist yet (the common case for writes) resolves as far as it can — the
 * nearest existing ancestor is what a symlink could have redirected, and the
 * remaining components cannot.
 */
export function resolveCandidate(raw: string, policy: JailPolicy, cwd: string): string {
  let text = raw.trim();
  if (text === "" || text === "~" || text === "~/" || text === "$HOME" || text === "$HOME/") return policy.home;
  if (text.startsWith("~/")) {
    text = path.join(policy.home, text.slice(2));
  } else if (text.startsWith("$HOME/") || text.startsWith("${HOME}/")) {
    // The variable form is what a shell command carries literally; expanding it
    // against the JAIL home is what makes `cat ~/.ssh/id_ed25519` a miss instead
    // of a handover.
    text = path.join(policy.home, text.slice(text.startsWith("$HOME/") ? 6 : 8));
  } else if (!path.isAbsolute(text)) {
    text = path.resolve(cwd, text);
  } else {
    text = path.resolve(text);
  }
  return realish(text);
}

/** `realpath` on the longest existing prefix, keeping the rest joined on. */
function realish(absolute: string): string {
  let current = absolute;
  const tail: string[] = [];
  for (let guard = 0; guard < 64; guard += 1) {
    try {
      const real = fs.realpathSync(current);
      return tail.length === 0 ? real : path.join(real, ...tail.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return absolute;
      tail.push(path.basename(current));
      current = parent;
    }
  }
  return absolute;
}

/** Where a resolved path stands relative to the jail. */
export function classifyResolved(resolved: string, policy: JailPolicy): Verdict {
  if (under(resolved, policy.root)) return { allowed: true };
  if (under(resolved, policy.home)) return { allowed: true };
  if (policy.allow.some((entry) => under(resolved, entry))) return { allowed: true };
  if (policy.system.some((entry) => under(resolved, entry))) return { allowed: true };
  return { allowed: false, path: resolved, reason: "outside the jail" };
}

/** Read-only by rule: everything the jail does not own. */
export function isWritable(resolved: string, policy: JailPolicy): boolean {
  return under(resolved, policy.root) || under(resolved, policy.home);
}

function under(candidate: string, root: string): boolean {
  const rel = path.relative(path.resolve(root), candidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Path-shaped tokens in a shell command.
 *
 * Deliberately a recogniser, not a parser: an adversary who wants to lose the
 * fence will write `$(printf L2V0Yw== | base64 -d)/passwd`, and no token scan
 * catches that. What this catches is the overwhelmingly common case — the
 * absolute path, the `..`, the `~/secrets`, the `git -C ../other-repo` — which
 * is what an accident and a prompted-into-it mistake look like.
 *
 * Bare words are not paths (a command called `etc` is not `/etc`), so anything
 * returned here is either absolute, home- or variable-rooted, or contains a
 * traversal.
 */
export function pathsInCommand(command: string): string[] {
  const out: string[] = [];
  // Tokens, with quotes respected enough that "echo '/etc/passwd'" still shows
  // the path and a URL does not.
  for (const raw of tokenize(command)) {
    const token = raw.replace(/^["']+|["']+$/g, "");
    if (!token) continue;
    // URLs, e-mail, and scp-style remotes name a host, not a local path.
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(token) || /^[A-Za-z0-9._-]+:[^\s/]*$/.test(token)) continue;
    if (
      token.startsWith("/") ||
      token === "~" ||
      token.startsWith("~/") ||
      token.startsWith("$HOME") ||
      token === ".." ||
      token.startsWith("../") ||
      token.includes("/../")
    ) {
      out.push(token);
    }
  }
  return out;
}

/** Split on whitespace and shell operators, honouring single/double quotes. */
function tokenize(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch) || ";|&<>=()`".includes(ch)) {
      if (current) tokens.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current) tokens.push(current);
  return tokens;
}

/** Keys whose values are paths, per built-in tool. Unknown tools are scanned
 *  generically: an MCP tool that takes `file_path` should not be an invisible
 *  way out. */
const PATH_KEYS: Record<string, string[]> = {
  read: ["path"],
  write: ["path"],
  edit: ["path", "file_path"],
  grep: ["path"],
  find: ["path"],
  ls: ["path"],
  glob: ["path"],
};

export interface ToolCallDecision {
  /** Refuse the call, with the reason the model sees. */
  block?: { reason: string };
  /** Debug trace: what was looked at and what was decided. */
  checked: string[];
}

/**
 * The one entry point the extension calls.
 *
 * Writes are held to what the jail owns; reads additionally accept the
 * read-only set. A write that merely *reads* an outside path (`cat /etc/hosts >
 * out`) is caught by the bash scan, which classifies every path it finds, not
 * just the output one.
 */
export function decideToolCall(
  toolName: string,
  input: Record<string, unknown> | undefined,
  policy: JailPolicy,
  cwd: string,
  writing: boolean
): ToolCallDecision {
  const checked: string[] = [];
  const candidates: string[] = [];
  const keys = PATH_KEYS[toolName];
  if (keys && input) {
    for (const key of keys) {
      const value = input[key];
      if (typeof value === "string" && value.trim() !== "") candidates.push(value);
    }
  } else if (toolName === "bash" && input && typeof input.command === "string") {
    candidates.push(...pathsInCommand(input.command));
  } else if (input) {
    // Unknown tool: scan every string value that looks like a path.
    for (const value of Object.values(input)) {
      if (typeof value === "string" && /^(~|\$HOME|\.\.|\/)/.test(value.trim())) candidates.push(value);
    }
  }

  for (const candidate of candidates) {
    const resolved = resolveCandidate(candidate, policy, cwd);
    checked.push(resolved);
    const verdict = classifyResolved(resolved, policy);
    if (!verdict.allowed) {
      return { block: { reason: `${candidate} is ${verdict.reason} (${resolved})` }, checked };
    }
    if (writing && !isWritable(resolved, policy)) {
      return { block: { reason: `${resolved} is read-only inside the jail` }, checked };
    }
  }
  return { checked };
}
