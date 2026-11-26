/**
 * The guard extension as pi loads it (docs/specs/channel-jail.md).
 *
 * The rules are unit-tested elsewhere; this pins the adapter: the values the
 * bridge passes in the environment actually reach the policy, and a call that
 * crosses the boundary comes back blocked with a reason the model can act on.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { realpathSync, mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

interface FakePi {
  handlers: Record<string, (event: unknown) => { block?: boolean; reason?: string } | undefined>;
  on: (name: string, handler: (event: unknown) => { block?: boolean; reason?: string } | undefined) => void;
}

function makePi(): FakePi {
  const handlers: FakePi["handlers"] = {};
  return { handlers, on: (name, handler) => { handlers[name] = handler; } };
}

let root: string;
let home: string;

beforeEach(() => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "pi-guard-")));
  root = join(tmp, "jail");
  home = join(tmp, "home");
  mkdirSync(root, { recursive: true });
  mkdirSync(home, { recursive: true });
});

async function load(env: Record<string, string>): Promise<FakePi> {
  Object.assign(process.env, env);
  vi.resetModules();
  const pi = makePi();
  const mod = await import("../src/jail/guard.js");
  (mod.default as unknown as (api: unknown) => void)(pi);
  return pi;
}

describe("the guard as loaded by pi", () => {
  it("refuses a read outside the root, with a reason that names the way back", async () => {
    const pi = await load({
      PI_COURIER_JAIL_ROOT: root,
      PI_COURIER_JAIL_HOME: home,
      PI_COURIER_JAIL_ALLOW: ""
    });
    const verdict = pi.handlers.tool_call!({ toolName: "read", input: { path: "/etc/ssh/ssh_config" } });
    expect(verdict?.block).toBe(true);
    expect(verdict?.reason).toContain("Jail:");
    expect(verdict?.reason).toContain(root);
  });

  it("allows work inside the root and the jail home", async () => {
    const pi = await load({ PI_COURIER_JAIL_ROOT: root, PI_COURIER_JAIL_HOME: home, PI_COURIER_JAIL_ALLOW: "" });
    expect(pi.handlers.tool_call!({ toolName: "write", input: { path: join(root, "a.txt") } })).toBeUndefined();
    expect(pi.handlers.tool_call!({ toolName: "read", input: { path: join(home, ".gitconfig") } })).toBeUndefined();
  });

  it("keeps the read-only list readable and unwritable", async () => {
    const agent = join(root, "..", "agentdir");
    mkdirSync(agent, { recursive: true });
    const pi = await load({
      PI_COURIER_JAIL_ROOT: root,
      PI_COURIER_JAIL_HOME: home,
      PI_COURIER_JAIL_ALLOW: realpathSync(join(agent, "..")) === "" ? "" : agent
    });
    expect(pi.handlers.tool_call!({ toolName: "read", input: { path: join(agent, "skills/x/SKILL.md") } })).toBeUndefined();
    expect(pi.handlers.tool_call!({ toolName: "write", input: { path: join(agent, "extensions/evil.ts") } })?.block).toBe(true);
  });

  it("still blocks when the tool is one it has never heard of", async () => {
    const pi = await load({ PI_COURIER_JAIL_ROOT: root, PI_COURIER_JAIL_HOME: home, PI_COURIER_JAIL_ALLOW: "" });
    expect(pi.handlers.tool_call!({ toolName: "mcp__fs__read", input: { file: "/root/keys.pem" } })?.block).toBe(true);
  });
});
