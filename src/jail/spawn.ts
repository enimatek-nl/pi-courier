/**
 * How a jailed instance is spawned (docs/specs/channel-jail.md).
 *
 * The bridge spawns pi itself, so it decides what a jailed session can see at
 * all. Three decisions live here, one function each, so the tests can pin them
 * without starting a process.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { runtimeHomedir, runtimeLayout } from "../config.js";
import { jailHomeFor } from "./rules.js";

/**
 * The guard extension, as a path pi can load.
 *
 * Both spellings are looked for because the same source runs two ways: compiled
 * (`dist/jail/guard.js`) in production, and straight from `src/` under the test
 * runner. Preferring the compiled file keeps production from depending on pi's
 * TypeScript loader.
 */
export function guardExtensionPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, "guard.js"),
    path.join(here, "..", "..", "dist", "jail", "guard.js"),
    path.join(here, "guard.ts")
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0]!;
}

/**
 * The jail home: a bridge-owned directory under the state root, never inside
 * the session's own writable root.
 *
 * Placing it inside the jail would let the session write its own `~/.ssh/config`
 * or `~/.gitconfig`, and every rule that resolves `~` would then be evaluated
 * against a home the confined party controls.
 */
export function jailHomeDir(roomId: string): string {
  return jailHomeFor(runtimeLayout().stateDir, roomId);
}

/** pi's own configuration directory — settings, skills, AGENTS.md, credentials. */
export function piAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || path.join(runtimeLayout().piHome, "agent");
}

/**
 * Read-only exceptions besides the agent directory: user-level resource roots
 * that live outside it. `~/.agents` (where skills are kept on hosts that use it)
 * is the one this project meets in practice; a session that cannot read skills
 * is a worse agent, and reading them is not what the jail is for.
 */
function extraResourceRoots(): string[] {
  const home = runtimeHomedir();
  return [path.join(home, ".agents")].filter((dir) => fs.existsSync(dir));
}

export interface JailSpawnOptions {
  home: string;
  allow: string[];
  agentDir: string;
}

/** Everything the spawn needs to confine one room, given its bound directory. */
export function jailSpawnOptions(_workdir: string, roomId: string): JailSpawnOptions {
  const agentDir = piAgentDir();
  const allow = [agentDir, ...extraResourceRoots().filter((dir) => dir !== agentDir)];
  return { home: jailHomeDir(roomId), allow, agentDir };
}
