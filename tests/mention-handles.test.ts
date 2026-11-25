/**
 * Handle matching in outgoing answers (spec docs/specs/mention-handles.md).
 *
 * Two things are pinned here: who gets recognised, and who is deliberately
 * left alone. The second half matters more than the first — model output about
 * this project is full of `@Override`, `@matrix-org/scopes` and `@0x1f`, and a
 * bridge that tags strangers for every `@thing` gets muted by its first room.
 */
import { describe, expect, it } from "vitest";
import { extractHandles, resolveHandles, mentionPrefix, MAX_HANDLE_MENTIONS } from "../src/mentions/handles.js";

describe("extractHandles", () => {
  it("finds both spellings, in text order, once each", () => {
    expect(extractHandles("ask @claude and @claude:cluephone.org, then @ada")).toEqual([
      "claude",
      "claude:cluephone.org",
      "ada"
    ]);
  });

  it("keeps the characters a real MXID localpart has", () => {
    expect(extractHandles("@bob.smith-2_x=3 @up:lower")).toEqual(["bob.smith-2_x=3", "up:lower"]);
  });

  it("drops the punctuation a sentence leaves behind", () => {
    expect(extractHandles("ping @ada. cc @bob:example.org! (see @cybertim)")).toEqual(["ada", "bob:example.org", "cybertim"]);
  });

  it("ignores e-mail addresses, where the @ is not a handle", () => {
    expect(extractHandles("mail me at pico@example.org please")).toEqual([]);
  });

  it("ignores npm scopes and code, which is where most @tokens live", () => {
    // A slash ends the candidate: scoped package names are the commonest @thing
    // in output about this project, and none of them names a person.
    expect(extractHandles("uses @matrix-org/matrix-sdk-crypto-nodejs and @vitest/runner")).toEqual([]);
    expect(extractHandles("rename `@ada` in the code")).toEqual([]);
    expect(extractHandles("```java\n@Override\npublic void x() {}\n```")).toEqual([]);
  });

  it("collects bare words that merely look like handles — resolution decides", () => {
    // Extraction is a candidate finder, not a judge: `@keyframes` and decorators
    // in prose cannot be told apart from a person by shape alone. They are
    // dropped because no member of the room answers to them (see resolveHandles).
    expect(extractHandles("@keyframes spin {}\n\n@ada says hi")).toEqual(["keyframes", "ada"]);
    expect(resolveHandles(["keyframes", "ada"], ["@ada:example.org"]).userIds).toEqual(["@ada:example.org"]);
  });
});

describe("resolveHandles", () => {
  const members = ["@claude:cluephone.org", "@pico:matrix.enimatek.nl", "@ada:example.org", "@ada:other.org"];

  it("matches a bare localpart when exactly one member carries it", () => {
    expect(resolveHandles(["claude"], members).userIds).toEqual(["@claude:cluephone.org"]);
  });

  it("refuses to guess between two people with the same localpart", () => {
    const decision = resolveHandles(["ada"], members);
    expect(decision.userIds).toEqual([]);
    expect(decision.skipped).toEqual([{ handle: "ada", reason: "ambiguous" }]);
  });

  it("resolves a full MXID only when that exact person is in the room", () => {
    expect(resolveHandles(["ada:other.org"], members).userIds).toEqual(["@ada:other.org"]);
    expect(resolveHandles(["someone:else.org"], members).skipped).toEqual([{ handle: "someone:else.org", reason: "unknown" }]);
    // Right localpart, wrong homeserver: not a member, so nobody is tagged.
    expect(resolveHandles(["ada:somewhere.else"], members).userIds).toEqual([]);
  });

  it("compares case-insensitively and answers with the member's own spelling", () => {
    const mixed = ["@Claude:CluePhone.org"];
    expect(resolveHandles(["CLAUDE:cluephone.org"], mixed).userIds).toEqual(["@Claude:CluePhone.org"]);
  });

  it("never tags the bridge itself or someone already mentioned", () => {
    const decision = resolveHandles(["pico", "claude"], members, {
      selfUserId: "@pico:matrix.enimatek.nl",
      alreadyMentioned: ["@claude:cluephone.org"]
    });
    expect(decision.userIds).toEqual([]);
    expect(decision.skipped.map((s) => s.reason)).toEqual(["self", "already"]);
  });

  it("counts one person written two ways as one mention", () => {
    expect(resolveHandles(["claude", "claude:cluephone.org"], members).userIds).toEqual(["@claude:cluephone.org"]);
  });

  it("caps the wall of mentions but keeps the first ones in order", () => {
    const crowd = Array.from({ length: MAX_HANDLE_MENTIONS + 3 }, (_, i) => `@user${i}`);
    const inRoom = Array.from({ length: crowd.length }, (_, i) => `@user${i}:example.org`);
    const decision = resolveHandles(crowd, inRoom);
    expect(decision.userIds).toHaveLength(MAX_HANDLE_MENTIONS);
    expect(decision.userIds[0]).toBe("@user0:example.org");
    expect(decision.skipped.at(-1)).toEqual({ handle: `@user${crowd.length - 1}`, reason: "capped" });
  });

  it("matches nobody when the room could not be read", () => {
    expect(resolveHandles(["claude"], []).userIds).toEqual([]);
  });

  it("leaves annotations and decorators alone, because nobody answers to them", () => {
    expect(resolveHandles(["Component", "Injectable", "Override"], members).userIds).toEqual([]);
  });
});

describe("mentionPrefix", () => {
  it("is one MXID per line, and empty when there is nobody to name", () => {
    expect(mentionPrefix(["@a.example.org", "@b:example.org"].map((s) => s.replace("a.", "a:")))).toBe(
      "@a:example.org\n@b:example.org"
    );
    expect(mentionPrefix([])).toBe("");
  });
});
