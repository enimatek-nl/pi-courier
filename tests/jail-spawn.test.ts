/**
 * Jail wiring: what the bridge actually puts on the child process
 * (docs/specs/channel-jail.md).
 *
 * The rules decide which paths are refused; this file pins that a guarded room
 * gets them enforced at all — extension loaded, project resources refused, home
 * rewritten — and, just as importantly, that an unguarded room's spawn is
 * byte-for-byte what it was before the feature existed.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ConfigStore } from "../src/config";
import { setRuntimeLayoutForTests } from "../src/config";
import type { Layout } from "../src/paths";
import { ProjectManager } from "../src/rpc/project-manager";
import { guardExtensionPath, jailHomeDir, piAgentDir } from "../src/jail/spawn";
import type { PiRpc, PiRpcOptions, RpcEventListener } from "../src/rpc/pi-rpc";

const LAYOUT = {
  stateDir: "/state",
  configDir: "/config",
  dataDir: "/data",
  piHome: "/home/you/.pi"
} as unknown as Layout;

interface Spawned {
  opts: PiRpcOptions;
  listeners: RpcEventListener[];
}

function makePM(projects: Record<string, { workdir: string; guard?: boolean }>) {
  const spawned: Spawned[] = [];
  const store = new ConfigStore({ projects, managementRooms: [], workdir: "/home/you/Projects", multiProject: true }, () => {});
  const pm = new ProjectManager({
    defaultRpc: { start: async () => {}, label: "default" } as unknown as PiRpc,
    baseOptions: { args: ["--continue"] },
    onRoomEvent: () => {},
    multiProject: true,
    store,
    rpcFactory: ((opts: PiRpcOptions) => {
      const record: Spawned = { opts, listeners: [] };
      spawned.push(record);
      return {
        start: async () => {},
        label: opts.label,
        onEvent: (l: RpcEventListener) => record.listeners.push(l)
      } as unknown as PiRpc;
    }) as unknown as NonNullable<ConstructorParameters<typeof ProjectManager>[0]["rpcFactory"]>
  });
  return { pm, spawned };
}

beforeEach(() => {
  setRuntimeLayoutForTests(LAYOUT);
});

describe("guarding a room at spawn", () => {
  it("loads the guard, refuses project resources, and rewrites home", async () => {
    const { pm, spawned } = makePM({ "!jail:s": { workdir: "/srv/jail/room", guard: true } });
    await pm.getRpcForRoom("!jail:s");
    const opts = spawned[0]!.opts;
    const args = opts.args ?? [];
    expect(args).toContain("-e");
    expect(args[args.indexOf("-e") + 1]).toMatch(/jail\/guard\.(js|ts)$/);
    // Project resources inside a jail are the confined party's own code: an
    // extension it wrote in its own workdir would otherwise load at the next
    // spawn, outside the guard.
    expect(args).toContain("--no-approve");
    expect(opts.cwd).toBe("/srv/jail/room");
    expect(opts.jail?.home.startsWith("/state/jails/")).toBe(true);
    expect(opts.jail?.home.endsWith("/home")).toBe(true);
    expect(opts.jail?.agentDir).toBe("/home/you/.pi/agent");
    // The agent directory is the read-only exception pi needs to start at all.
    expect(opts.jail?.allow).toContain("/home/you/.pi/agent");
  });

  it("leaves an unguarded room exactly as it was", async () => {
    const { pm, spawned } = makePM({ "!plain:s": { workdir: "/home/you/Projects/plain" } });
    await pm.getRpcForRoom("!plain:s");
    const opts = spawned[0]!.opts;
    expect(opts.args).toEqual(["--continue", "--session-dir", "/home/you/Projects/plain/.pi-session"]);
    expect(opts.jail).toBeUndefined();
  });

  it("gives each jailed room its own home", async () => {
    const { pm, spawned } = makePM({
      "!a:s": { workdir: "/srv/a", guard: true },
      "!b:s": { workdir: "/srv/b", guard: true }
    });
    await pm.getRpcForRoom("!a:s");
    await pm.getRpcForRoom("!b:s");
    const [homes, roots] = [spawned.map((s) => s.opts.jail?.home), spawned.map((s) => s.opts.jail?.allow)];
    expect(new Set(homes).size).toBe(2);
    expect(roots[0]).toEqual(roots[1]);
  });
});

describe("guard extension path", () => {
  it("resolves to a file the loader can read", () => {
    const p = guardExtensionPath();
    expect(existsSync(p)).toBe(true);
    expect(p).toContain("guard.");
  });

  it("puts the jail home under the bridge's own state root, never in the room", () => {
    const home = jailHomeDir("!room:server");
    expect(home.startsWith("/state/jails/")).toBe(true);
    expect(home).not.toContain("/srv");
  });

  it("points pi at the agent directory it must keep reading", () => {
    expect(piAgentDir()).toBe("/home/you/.pi/agent");
  });
});
