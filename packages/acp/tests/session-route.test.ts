/**
 * Tier SR — the construction route
 * (specs/native-agent-session-launch-spec.md §Construction route).
 *
 * A route says how a logical session was first constructed, and nothing else.
 * It grants no right to ensure, prompt, detach, spawn or resume — the merged
 * coordinator remains the single live authority — so every case here is about
 * one question: can a later attachment be made to believe something about a
 * session that is not true?
 *
 * The strictness is the feature. Missing, extra, unknown-schema, malformed and
 * moved state all refuse rather than being read partially, and a winner is
 * never overwritten, deleted or converted to make a later caller's account
 * true.
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { all, ensure, scoped, until } from "effection";
import type { Operation } from "effection";
import { ensureDir, readTextFile, rm, writeTextFile } from "@effectionx/fs";
import { randomUUID } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { agentSessionKeyDigest } from "@executablemd/runtime";
import type { AgentSessionKey } from "@executablemd/runtime";
import {
  AgentSessionRouteError,
  createDenoSessionRouteStore,
  createMemorySessionRouteStore,
  hasDenoSessionRouteStore,
  parseAgentSessionRoute,
  serializeAgentSessionRoute,
} from "../src/session-route.ts";
import type { AgentSessionRouteStore, AgentSessionRouteV1 } from "../src/session-route.ts";
import { cliBase } from "@executablemd/test-support/launch";

const KEY: AgentSessionKey = {
  provider: "acpx",
  agent: "claude-cmd",
  sessionKey: "xmd:v1:aaaa:bbbb:cccc",
};

const BINDING = {
  schema: "executable-build.v1" as const,
  reportedVersion: "2.1.235",
  executableDigest: { algorithm: "sha256" as const, value: "c".repeat(64) },
};

function acpFirst(key: AgentSessionKey = KEY): AgentSessionRouteV1 {
  return {
    schema: "session-route.v1",
    route: "acp-first",
    provider: key.provider,
    agent: key.agent,
    sessionKey: key.sessionKey,
  };
}

function clientNative(
  overrides: Partial<Extract<AgentSessionRouteV1, { route: "client-native" }>> = {},
): AgentSessionRouteV1 {
  return {
    schema: "session-route.v1",
    route: "client-native",
    provider: KEY.provider,
    agent: KEY.agent,
    sessionKey: KEY.sessionKey,
    nativeSessionId: "11111111-2222-3333-4444-555555555555",
    identityProvenance: "client-allocated",
    instructionsDigest: "b".repeat(64),
    launcher: "claude",
    executableBinding: BINDING,
    ...overrides,
  };
}

function* workspace(): Operation<string> {
  const root = path.join(os.tmpdir(), `xmd-sr-${randomUUID()}`);
  yield* ensureDir(root);
  yield* ensure(() => rm(root, { recursive: true, force: true }));
  return root;
}

/** Both stores, so every semantic case is asserted against each. */
function* stores(): Operation<{ name: string; store: AgentSessionRouteStore }[]> {
  const root = yield* workspace();
  const durable = createDenoSessionRouteStore(root);
  if (!durable) {
    throw new Error("this host keeps no durable routes");
  }
  return [
    { name: "memory", store: createMemorySessionRouteStore() },
    { name: "file", store: durable },
  ];
}

describe("Tier SR — the construction route", () => {
  it("SR1: both members round-trip through the strict reader", function* () {
    for (const route of [acpFirst(), clientNative()]) {
      const text = serializeAgentSessionRoute(route);
      expect(parseAgentSessionRoute(JSON.parse(text))).toEqual(route);
    }
  });

  it("SR2: an acp-first record carries nothing about a provider session", function* () {
    // The point of the shape: there is nothing to say about a session ACP
    // created beyond that ACP created it.
    const text = serializeAgentSessionRoute(acpFirst());
    expect(Object.keys(JSON.parse(text)).sort()).toEqual([
      "agent",
      "provider",
      "route",
      "schema",
      "sessionKey",
    ]);
  });

  it("SR3: a client-native record carries no path, environment, or instruction text", function* () {
    const text = serializeAgentSessionRoute(clientNative());
    expect(Object.keys(JSON.parse(text)).sort()).toEqual([
      "agent",
      "executableBinding",
      "identityProvenance",
      "instructionsDigest",
      "launcher",
      "nativeSessionId",
      "provider",
      "route",
      "schema",
      "sessionKey",
    ]);
    expect(text).not.toContain("/");
  });

  it("SR4: every way a record can be wrong refuses rather than reading partially", function* () {
    const good = clientNative() as Record<string, unknown>;
    const cases: [string, unknown][] = [
      ["not an object", "session-route.v1"],
      ["unknown schema", { ...good, schema: "session-route.v2" }],
      ["unknown route", { ...good, route: "native-first" }],
      ["extra member", { ...good, origin: "migrated" }],
      ["missing member", (({ launcher: _l, ...rest }) => rest)(good)],
      ["empty session key", { ...good, sessionKey: "" }],
      ["short instruction digest", { ...good, instructionsDigest: "b".repeat(63) }],
      ["wrong provenance", { ...good, identityProvenance: "provider-returned" }],
      [
        "binding with an extra member",
        {
          ...good,
          executableBinding: { ...BINDING, path: "/usr/local/bin/claude" },
        },
      ],
      [
        "binding with an unknown algorithm",
        {
          ...good,
          executableBinding: {
            ...BINDING,
            executableDigest: { algorithm: "sha1", value: "c".repeat(64) },
          },
        },
      ],
      // The suspended branch's shape was never a released compatibility
      // boundary, so it is unknown state like any other.
      [
        "the unmerged legacy mapping",
        {
          schema: "native-session-mapping.v1",
          provider: "acpx",
          agent: "claude-cmd",
          sessionKey: KEY.sessionKey,
          nativeSessionId: "x",
          origin: "client-native",
        },
      ],
      [
        "acp-first carrying provider identity",
        {
          ...acpFirst(),
          nativeSessionId: "11111111-2222-3333-4444-555555555555",
        },
      ],
    ];
    for (const [name, value] of cases) {
      expect([name, parseAgentSessionRoute(value)]).toEqual([name, undefined]);
    }
  });

  it("SR5: publication is create-once, and the loser adopts the winner", function* () {
    for (const { name, store } of yield* stores()) {
      const first = yield* store.publish(clientNative());
      const second = yield* store.publish(acpFirst());

      // The second caller described a different session. It does not get to
      // replace the first account, and it does not get a partial one.
      expect([name, first.route]).toEqual([name, "client-native"]);
      expect([name, second]).toEqual([name, first]);
      expect([name, yield* store.read(KEY)]).toEqual([name, first]);
    }
  });

  it("SR6: an absent route reads as absent, in both stores", function* () {
    for (const { name, store } of yield* stores()) {
      expect([name, yield* store.read(KEY)]).toEqual([name, undefined]);
    }
  });

  it("SR7: a record that names another session refuses", function* () {
    const root = yield* workspace();
    const store = createDenoSessionRouteStore(root)!;
    const directory = path.join(root, "routes");
    yield* ensureDir(directory);
    // Planted under this key's digest, naming a different one: a moved
    // record is state this build cannot account for.
    yield* writeTextFile(
      path.join(directory, `${agentSessionKeyDigest(KEY)}.json`),
      serializeAgentSessionRoute(acpFirst({ ...KEY, sessionKey: "xmd:v1:other" })),
    );

    let refused: Error | undefined;
    try {
      yield* store.read(KEY);
    } catch (error) {
      refused = error instanceof Error ? error : new Error(String(error));
    }
    expect(refused).toBeInstanceOf(AgentSessionRouteError);
    expect(refused?.message).toContain("names a different session");
  });

  it("SR12: a durable record that is present and wrong refuses; an absent one does not", function* () {
    // SR4 is the reader's own claim, made against values. This is the store's:
    // a route the durable path holds is either a record this build accepts or a
    // refusal — never a partial read, and never mistaken for the one state that
    // legitimately means "no route", which is that the file is not there.
    const planted: [string, string][] = [
      ["not JSON at all", "{ this was never a record"],
      ["JSON that is not an object", '"session-route.v1"'],
      ["an unknown schema", JSON.stringify({ schema: "session-route.v2", route: "acp-first" })],
      [
        "a client-native record missing its identity",
        JSON.stringify({
          schema: "session-route.v1",
          route: "client-native",
          provider: "acpx",
          agent: "claude-cmd",
          sessionKey: KEY.sessionKey,
          identityProvenance: "client-allocated",
          instructionsDigest: "a".repeat(64),
          launcher: "claude",
          executableBinding: BINDING,
        }),
      ],
      ["an empty file", ""],
    ];

    for (const [name, content] of planted) {
      const root = yield* workspace();
      const store = createDenoSessionRouteStore(root)!;
      const directory = path.join(root, "routes");
      yield* ensureDir(directory);
      const record = path.join(directory, `${agentSessionKeyDigest(KEY)}.json`);

      // Absent first, from the same store at the same path: the distinction
      // this case exists to pin is between nothing and something wrong.
      expect([name, yield* store.read(KEY)]).toEqual([name, undefined]);

      yield* writeTextFile(record, content);
      let refused: Error | undefined;
      try {
        yield* store.read(KEY);
      } catch (error) {
        refused = error instanceof Error ? error : new Error(String(error));
      }
      expect([name, refused instanceof AgentSessionRouteError]).toEqual([name, true]);
      // And it stands: reading did not repair, replace or remove it.
      expect([name, yield* readTextFile(record)]).toEqual([name, content]);
    }
  });

  it("SR8: the namespace is the coordinator's, with 0700 directories and 0600 records", function* () {
    const root = yield* workspace();
    const store = createDenoSessionRouteStore(root)!;
    yield* store.publish(clientNative());

    const directory = path.join(root, "routes");
    const record = path.join(directory, `${agentSessionKeyDigest(KEY)}.json`);
    expect((yield* until(stat(directory))).mode & 0o777).toBe(0o700);
    expect((yield* until(stat(record))).mode & 0o777).toBe(0o600);

    // Named by digest alone: the namespace holds no agent name, session name,
    // path or authored value.
    expect(path.basename(record)).toBe(`${agentSessionKeyDigest(KEY)}.json`);
    const text = yield* until(readFile(record, "utf8"));
    expect(text).not.toContain(root);
  });

  it("SR9: no staging file survives a publication", function* () {
    const root = yield* workspace();
    const store = createDenoSessionRouteStore(root)!;
    yield* store.publish(acpFirst());
    yield* store.publish(clientNative());

    const entries = yield* until(readdir(path.join(root, "routes")));
    expect(entries).toEqual([`${agentSessionKeyDigest(KEY)}.json`]);
  });

  it("SR10: two real processes racing one route adopt one winner", function* () {
    // One runtime racing itself shares a filesystem cache and a scheduler, and
    // would agree with a broken create-once as readily as a working one.
    const root = yield* workspace();
    const ready = path.join(root, "go");
    const fixture = path.join(import.meta.dirname!, "fixtures", "session-route-publisher.ts");

    const children = [
      "aaaaaaaa-1111-2222-3333-444444444444",
      "bbbbbbbb-1111-2222-3333-444444444444",
    ].map((native) =>
      new Deno.Command(cliBase()[0]!, {
        args: ["run", "--allow-all", fixture, root, KEY.sessionKey, native, ready],
        stdout: "piped",
        stderr: "piped",
      }).output(),
    );

    // Both exist before either may publish.
    yield* until(new Promise((resolve) => setTimeout(resolve, 300)));
    yield* writeTextFile(ready, "go\n");

    const outputs = yield* all(children.map((child) => until(child)));
    const decoder = new TextDecoder();
    const winners = outputs.map((output) => {
      expect(output.code).toBe(0);
      return JSON.parse(decoder.decode(output.stdout).trim()) as AgentSessionRouteV1;
    });

    // Both processes published, exactly one account exists, and both adopted
    // the same one.
    expect(winners[0]).toEqual(winners[1]);
    const store = createDenoSessionRouteStore(root)!;
    expect(yield* store.read(KEY)).toEqual(winners[0]);
  });

  it("SR11: this host keeps durable routes", function* () {
    expect(hasDenoSessionRouteStore()).toBe(true);
  });
});
