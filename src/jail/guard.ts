/**
 * The path guard: the extension a jailed pi instance is started with
 * (docs/specs/channel-jail.md).
 *
 * Loaded through `-e <this file>` by the bridge, and only for instances whose
 * binding is guarded. It does one thing: it refuses tool calls that reach
 * outside the jail. Every judgement is in rules.ts; this file is the adapter
 * from pi's `tool_call` event to that decision.
 *
 * Deliberately no import of the pi package. The file is loaded by pi's own
 * extension loader at a path inside this package, and a runtime import would
 * make the guard depend on the shape of a dependency it is supposed to survive
 * unchanged; `tool_call` has been `toolName` + `input` and blocking has been
 * `{ block: true, reason }` since the API documented it.
 *
 * What it is not: an operating-system boundary. Commands it fails to recognise
 * still run with this process's permissions, which is why the same directory
 * rules also refuse roots that contain the bridge, `$HOME`, or the credential
 * directories, and why the container remains the answer to a hostile
 * participant.
 */
import * as path from "node:path";
import { SYSTEM_READ_PATHS, decideToolCall, type JailPolicy } from "./rules.js";

/** The root this instance is confined to. The bridge passes it explicitly;
 *  falling back to the working directory keeps the guard correct when started
 *  by hand, and the value is captured now because it must not move later. */
const ROOT = path.resolve(process.env.PI_COURIER_JAIL_ROOT || process.cwd());

/** The jail's own home. The bridge sets `$HOME` to it for this process, so a
 *  model asking for `~/.ssh/id_rsa` asks for a file inside the jail and finds
 *  nothing — which is the point: the real home is not reachable by accident. */
const HOME = path.resolve(process.env.PI_COURIER_JAIL_HOME || process.env.HOME || ROOT);

/** Read-only exceptions: the pi agent directory (settings, skills, AGENTS.md,
 *  auth.json — pi needs them, and a session that could write them could install
 *  an extension the host loads) plus any configured resource roots. */
const ALLOW = (process.env.PI_COURIER_JAIL_ALLOW || "")
  .split(path.delimiter === ":" ? ":" : path.delimiter)
  .map((entry) => entry.trim())
  .filter((entry) => entry !== "")
  .map((entry) => path.resolve(entry));

const CWD_AT_LOAD = path.resolve(process.cwd());

const policy: JailPolicy = {
  root: ROOT,
  home: HOME,
  allow: ALLOW,
  system: SYSTEM_READ_PATHS
};

/**stderr is the bridge's log: the RPC client forwards the child's stderr
 *  verbatim, so a refused call is visible where the operator can see it
 *  without the model having to repeat it. */
function note(line: string): void {
  process.stderr.write(`[pi-courier jail] ${line}\n`);
}

export default function jailGuard(pi: unknown): void {
  const on = (pi as { on?: (event: string, handler: (event: unknown) => unknown) => void }).on;
  if (typeof on !== "function") {
    note("this build of pi does not expose on(); the jail is NOT enforcing");
    return;
  }
  note(`guarding ${ROOT} (home ${HOME}${ALLOW.length > 0 ? `, read-only ${ALLOW.join(" ")}` : ""})`);

  on.call(pi, "tool_call", (event: unknown) => {
    const call = event as { toolName?: string; input?: Record<string, unknown> } | undefined;
    const toolName = call?.toolName ?? "";
    // A bash command is judged as a reader: the path set is the same, and
    // insisting that every path in a command be writable would refuse `cat
    // /etc/resolv.conf` while still not being able to stop a redirect.
    const decision = decideToolCall(toolName, call?.input, policy, CWD_AT_LOAD, toolName !== "bash" && toolName !== "read");
    if (decision.block) {
      note(`blocked ${toolName || "tool"}: ${decision.block.reason}`);
      return { block: true, reason: `Jail: ${decision.block.reason}. Work inside ${ROOT}.` };
    }
    return undefined;
  });
}
