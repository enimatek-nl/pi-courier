/**
 * Channel key repair (docs/specs/channel-jail.md).
 *
 * The cases worth pinning are the ones where a repair could destroy a decision:
 * a room entered twice, a lookup that fails, and a config with nothing to repair.
 */
import { describe, expect, it, vi } from "vitest";
import { migrateAliasChannelKeys, normalizeChannelArgument } from "../src/auth/channel-keys";

const entry = (mode: string, enabled = true) => ({ enabled, mode });

describe("migrateAliasChannelKeys", () => {
  it("moves an alias key onto the room id events carry", async () => {
    const report = await migrateAliasChannelKeys(
      { "#smaltino:server": entry("mentions-trusted") },
      async () => "!LO2:server"
    );
    expect(report.channels["!LO2:server"]).toMatchObject({ mode: "mentions-trusted" });
    expect(report.channels["#smaltino:server"]).toBeUndefined();
    expect(report.moved).toEqual(["#smaltino:server → !LO2:server"]);
    expect(report.unchanged).toBe(false);
  });

  it("keeps the id entry when both spellings name the same room", async () => {
    // Two entries, two decisions, one winner: the id entry has been the one
    // actually governing events, so the alias may not silently change its mode.
    const report = await migrateAliasChannelKeys(
      {
        "#smaltino:server": entry("all"),
        "!LO2:server": entry("mentions-trusted")
      },
      async () => "!LO2:server"
    );
    expect(report.channels["!LO2:server"]).toMatchObject({ mode: "mentions-trusted" });
    expect(report.channels["#smaltino:server"]).toBeUndefined();
    expect(report.dropped).toHaveLength(1);
  });

  it("leaves an alias it cannot resolve exactly where it was", async () => {
    // A homeserver that is briefly unreachable must not cost the operator their
    // configuration; the inert entry stays visible in /channels instead.
    const resolve = vi.fn(async () => null);
    const report = await migrateAliasChannelKeys({ "#ghost:server": entry("all") }, resolve);
    expect(report.channels["#ghost:server"]).toMatchObject({ mode: "all" });
    expect(report.unresolved).toEqual(["#ghost:server"]);
    expect(report.unchanged).toBe(true);
  });

  it("treats a throwing resolver as unresolved", async () => {
    const report = await migrateAliasChannelKeys({ "#boom:server": entry("all") }, async () => {
      throw new Error("sync down");
    });
    expect(report.channels["#boom:server"]).toBeDefined();
    expect(report.unresolved).toEqual(["#boom:server"]);
  });

  it("does not touch a config that has no alias keys", async () => {
    const resolve = vi.fn(async () => "!nope:server");
    const channels = { "!a:server": entry("all"), "!b:server": entry("mentions-trusted") };
    const report = await migrateAliasChannelKeys(channels, resolve);
    expect(report.unchanged).toBe(true);
    expect(report.channels).toBe(channels);
    expect(resolve).not.toHaveBeenCalled();
  });
});

describe("normalizeChannelArgument", () => {
  it("rewrites the alias in a /enable command to the room id", async () => {
    const text = await normalizeChannelArgument("/enable #smaltino:server mentions-trusted", async () => "!LO2:server");
    expect(text).toBe("/enable !LO2:server mentions-trusted");
  });

  it("keeps the command as typed when the alias does not resolve", async () => {
    const text = await normalizeChannelArgument("/disable #ghost:server", async () => null);
    expect(text).toBe("/disable #ghost:server");
  });

  it("leaves room ids and other commands alone", async () => {
    const resolve = vi.fn(async () => "!x:server");
    expect(await normalizeChannelArgument("/enable !LO2:server all", resolve)).toBe("/enable !LO2:server all");
    expect(await normalizeChannelArgument("/channels", resolve)).toBe("/channels");
    expect(resolve).not.toHaveBeenCalled();
  });
});
