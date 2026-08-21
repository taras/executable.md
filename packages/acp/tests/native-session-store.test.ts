/**
 * Tier NM — the durable Agent-session mapping
 * (specs/native-agent-session-launch-spec.md §Durability and replay).
 *
 * The store's whole job is that one logical session gets one native identity,
 * once, no matter how many attempts race for it. So these run against a real
 * filesystem: exclusivity here is a filesystem guarantee, and a store that
 * kept its records in a Map would prove the Map.
 *
 * The failure this defends against is not an error. It is two successful
 * preparations holding two identities, one of which names a conversation
 * nobody will ever see again.
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { useTempDirectory } from "@executablemd/test-support/temp";
import { all, until } from "effection";
import type { Operation } from "effection";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import * as path from "node:path";
import * as nodePath from "node:path";
import type { ExecutableBuildBindingV1 } from "@executablemd/core";
import {
  createMemorySessionRouteStore,
  createNativeSessionMappingStore,
  createSessionRouteStore,
  NativeSessionConflict,
  parseNativeSessionMapping,
  parseSessionRoute,
  routeFileFor,
} from "../src/native-session-store.ts";
import type {
  AcpFirstRoute,
  ClientNativeRoute,
  NativeSessionMapping,
} from "../src/native-session-store.ts";

/** The route files retained beneath `root`. */
function* routeFiles(root: string): Operation<string[]> {
  const entries = yield* until(readdir(root).catch(() => [] as string[]));
  return entries.filter((entry) => entry.endsWith(".json")).sort();
}

const BINDING: ExecutableBuildBindingV1 = {
  schema: "executable-build.v1",
  reportedVersion: "2.1.235 (Claude Code)",
  executableDigest: { algorithm: "sha256", value: "b".repeat(64) },
};

function mapping(overrides: Partial<NativeSessionMapping> = {}): NativeSessionMapping {
  return {
    schema: "native-session-mapping.v1",
    provider: "acp",
    agent: "claude",
    sessionKey: "session:main",
    nativeSessionId: "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0",
    identityProvenance: "client-allocated",
    instructionsDigest: "d".repeat(64),
    launcher: "claude",
    executableBinding: BINDING,
    ...overrides,
  };
}

/** The retained mapping files, so a test can count identities rather than calls. */
function* records(root: string): Operation<string[]> {
  const entries = yield* until(readdir(root).catch(() => [] as string[]));
  return entries.filter((entry) => entry.endsWith(".json")).sort();
}

/** An ACP-first route for the same logical session. */
function acpFirst(overrides: Partial<AcpFirstRoute> = {}): AcpFirstRoute {
  return {
    schema: "session-route.v1",
    route: "acp-first",
    provider: "acp",
    agent: "claude",
    sessionKey: "session:main",
    ...overrides,
  };
}

/** A client-native route carrying the identity XMD allocated. */
function clientNative(overrides: Partial<ClientNativeRoute> = {}): ClientNativeRoute {
  return {
    schema: "session-route.v1",
    route: "client-native",
    provider: "acp",
    agent: "claude",
    sessionKey: "session:main",
    nativeSessionId: "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0",
    identityProvenance: "client-allocated",
    instructionsDigest: "d".repeat(64),
    launcher: "claude",
    executableBinding: BINDING,
    ...overrides,
  };
}

describe("Tier RT — the durable construction route", () => {
  it("RT1: the first publication of either variant wins and reads back exactly", function* () {
    const root = yield* useTempDirectory("xmd-rt-");
    const acp = createSessionRouteStore(nodePath.join(root, "acp"));
    const native = createSessionRouteStore(nodePath.join(root, "native"));

    expect(yield* acp.publish(acpFirst())).toEqual(acpFirst());
    expect(yield* acp.read(acpFirst())).toEqual(acpFirst());
    expect(yield* native.publish(clientNative())).toEqual(clientNative());
    expect(yield* native.read(clientNative())).toEqual(clientNative());
  });

  it("RT2: an exact retry adopts the winner and publishes nothing new", function* () {
    const root = yield* useTempDirectory("xmd-rt-");
    const store = createSessionRouteStore(root);
    const first = yield* store.publish(clientNative());

    expect(yield* store.publish(clientNative())).toEqual(first);
    expect(yield* routeFiles(root)).toHaveLength(1);
  });

  it("RT3: a route never converts to the other variant", function* () {
    // The construction fence. Once a logical session is ACP-first, a native
    // launch cannot claim it, and once it is client-native no ACP work may
    // take it back — otherwise two owners each believe they chose the path.
    const root = yield* useTempDirectory("xmd-rt-");
    const store = createSessionRouteStore(root);
    yield* store.publish(acpFirst());

    let refused: unknown;
    try {
      yield* store.publish(clientNative());
    } catch (error) {
      refused = error;
    }

    expect(refused).toBeInstanceOf(NativeSessionConflict);
    expect(yield* store.read(acpFirst())).toEqual(acpFirst());
  });

  it("RT3b: an ACP-first claim over a client-native route is refused too", function* () {
    const root = yield* useTempDirectory("xmd-rt-");
    const store = createSessionRouteStore(root);
    yield* store.publish(clientNative());

    let refused: unknown;
    try {
      yield* store.publish(acpFirst());
    } catch (error) {
      refused = error;
    }

    expect(refused).toBeInstanceOf(NativeSessionConflict);
    expect((yield* store.read(clientNative()))?.route).toBe("client-native");
  });

  it("RT4: racing publications of one variant leave exactly one route", function* () {
    const root = yield* useTempDirectory("xmd-rt-");
    const settled = yield* all(
      Array.from({ length: 8 }, () => createSessionRouteStore(root).publish(acpFirst())),
    );

    expect(yield* routeFiles(root)).toHaveLength(1);
    expect(settled).toEqual(Array.from({ length: 8 }, () => acpFirst()));
  });

  it("RT5: racing client-native identities leave one, and the rest refuse", function* () {
    const root = yield* useTempDirectory("xmd-rt-");
    const candidates = Array.from({ length: 6 }, (_, index) =>
      clientNative({ nativeSessionId: `00000000-0000-4000-8000-00000000000${index}` }),
    );

    const settled = yield* all(
      candidates.map(function* (candidate) {
        try {
          return yield* createSessionRouteStore(root).publish(candidate);
        } catch (error) {
          if (error instanceof NativeSessionConflict) {
            return "refused" as const;
          }
          throw error;
        }
      }),
    );

    expect(yield* routeFiles(root)).toHaveLength(1);
    const retained = yield* createSessionRouteStore(root).read(candidates[0]!);
    expect(settled.filter((result) => result !== "refused")).toEqual([retained]);
  });

  it("RT6: every read verifies the retained natural key", function* () {
    const root = yield* useTempDirectory("xmd-rt-");
    const store = createSessionRouteStore(root);
    yield* store.publish(clientNative());
    const [file] = yield* until(readdir(root));
    yield* until(
      writeFile(
        nodePath.join(root, file!),
        JSON.stringify({ ...clientNative(), sessionKey: "session:elsewhere" }, null, 2),
      ),
    );

    let refused: unknown;
    try {
      yield* store.read(clientNative());
    } catch (error) {
      refused = error;
    }

    expect(refused).toBeInstanceOf(NativeSessionConflict);
  });

  it("RT7: unknown or partial route state is refused, never replaced", function* () {
    const complete = clientNative();
    const cases: Array<[string, unknown]> = [
      ["an unknown route schema", { ...complete, schema: "session-route.v2" }],
      ["an unknown variant", { ...complete, route: "provider-native" }],
      ["client-native with no identity", { ...complete, nativeSessionId: "" }],
      ["client-native with no binding", { ...complete, executableBinding: undefined }],
      [
        "acp-first carrying an identity",
        { ...acpFirst(), nativeSessionId: complete.nativeSessionId },
      ],
      ["acp-first carrying a binding", { ...acpFirst(), executableBinding: BINDING }],
    ];

    expect(cases.map(([name, value]) => [name, parseSessionRoute(value)])).toEqual(
      cases.map(([name]) => [name, undefined]),
    );
  });

  it("RT8: the pre-amendment mapping reads as a client-native route, unrewritten", function* () {
    // Recognized, not migrated. Rewriting a record merely because it was read
    // would turn every reader into a writer of state it does not own.
    const root = yield* useTempDirectory("xmd-rt-");
    const store = createSessionRouteStore(root);
    const legacy = {
      schema: "native-session-mapping.v1",
      provider: "acp",
      agent: "claude",
      sessionKey: "session:main",
      nativeSessionId: "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0",
      identityProvenance: "client-allocated",
      instructionsDigest: "d".repeat(64),
      launcher: "claude",
      executableBinding: BINDING,
    };
    yield* until(mkdir(root, { recursive: true, mode: 0o700 }));
    yield* until(
      writeFile(routeFileFor(root, clientNative()), JSON.stringify(legacy, null, 2), {
        mode: 0o600,
      }),
    );

    const read = yield* store.read(clientNative());

    // Every retained field is the route's, plus where the reading came from:
    // a record written before routes existed is the one case where whatever
    // ACPX holds beside it was never reconciled against this identity.
    expect(read).toEqual({ ...clientNative(), origin: "native-session-mapping.v1" });
    const after = JSON.parse(yield* until(readFile(routeFileFor(root, clientNative()), "utf8")));
    expect(after.schema).toBe("native-session-mapping.v1");
  });
});

describe("Tier RM — a route store held in memory", () => {
  // `<TestAgent>` retains its routes here rather than in the coordinator
  // namespace real invocations share. What it must still be is a route store:
  // create-once, strict about the natural key, and refusing what it cannot
  // reason about — otherwise a scenario proves a contract nothing enforces.

  it("RM1: each store is its own, and both variants round-trip", function* () {
    const first = createMemorySessionRouteStore();
    const second = createMemorySessionRouteStore();

    expect(yield* first.publish(acpFirst())).toEqual(acpFirst());
    expect(yield* first.read(acpFirst())).toEqual(acpFirst());
    // The same logical session, claimed the other way in a store of its own.
    // Sharing one would make two boundaries decide each other's construction.
    expect(yield* second.publish(clientNative())).toEqual(clientNative());
    expect(yield* second.read(clientNative())).toEqual(clientNative());
  });

  it("RM2: publication is create-once, and a route never converts", function* () {
    const store = createMemorySessionRouteStore();
    const first = yield* store.publish(clientNative());

    expect(yield* store.publish(clientNative())).toEqual(first);

    const refusals: unknown[] = [];
    for (const candidate of [
      clientNative({ nativeSessionId: "11111111-2222-4333-8444-555555555555" }),
      acpFirst(),
    ]) {
      try {
        yield* store.publish(candidate);
        refusals.push(undefined);
      } catch (error) {
        refusals.push(error);
      }
    }

    expect(refusals.every((error) => error instanceof NativeSessionConflict)).toBe(true);
    expect(yield* store.read(clientNative())).toEqual(first);
  });

  it("RM3: a read under another natural key finds nothing of this one's", function* () {
    const store = createMemorySessionRouteStore();
    yield* store.publish(clientNative());

    expect(
      yield* store.read({ provider: "acp", agent: "claude", sessionKey: "session:other" }),
    ).toBeUndefined();
    expect(
      yield* store.read({ provider: "acp", agent: "codex", sessionKey: "session:main" }),
    ).toBeUndefined();
  });

  it("RM4: it retains only what the file store would have accepted", function* () {
    // Held to the same strictness rather than trusted because it is in
    // process: a route this kept but that one would refuse is a scenario
    // proving behavior production never permits.
    const store = createMemorySessionRouteStore();

    let refused: unknown;
    try {
      yield* store.publish(clientNative({ nativeSessionId: "" }));
    } catch (error) {
      refused = error;
    }

    expect(refused).toBeInstanceOf(NativeSessionConflict);
    expect(yield* store.read(clientNative())).toBeUndefined();
  });
});

describe("Tier NM — native session mapping", () => {
  it("NM1: a created mapping reads back exactly", function* () {
    const root = yield* useTempDirectory("xmd-nm-");
    const store = createNativeSessionMappingStore(root);
    const written = mapping();

    yield* store.create(written);

    expect(yield* store.read(written)).toEqual(written);
  });

  it("NM2: an absent mapping reads as absent, not as an error", function* () {
    const root = yield* useTempDirectory("xmd-nm-");
    const store = createNativeSessionMappingStore(root);

    expect(yield* store.read(mapping())).toBeUndefined();
  });

  it("NM3: an exact retry adopts the existing identity and creates nothing", function* () {
    const root = yield* useTempDirectory("xmd-nm-");
    const store = createNativeSessionMappingStore(root);
    const first = yield* store.create(mapping());

    const second = yield* store.create(mapping());

    expect(second).toEqual(first);
    expect(yield* records(root)).toHaveLength(1);
  });

  it("NM4: concurrent writers of one identity all adopt it, and create it once", function* () {
    // The replay shape: several attempts carrying the same prepared identity
    // publish at once. Separate store instances, because two racing
    // preparations are two processes — a shared instance could coordinate in
    // memory and would prove nothing about the filesystem.
    const root = yield* useTempDirectory("xmd-nm-");
    const intended = mapping();

    const settled = yield* all(
      Array.from({ length: 8 }, () => createNativeSessionMappingStore(root).create(intended)),
    );

    expect(yield* records(root)).toHaveLength(1);
    expect(settled).toEqual(Array.from({ length: 8 }, () => intended));
  });

  it("NM4b: concurrent writers of different identities leave exactly one", function* () {
    // The dangerous shape: two preparations each allocated their own UUID.
    // One must win outright and the rest must refuse — never overwrite, and
    // never walk away believing their own identity was retained.
    const root = yield* useTempDirectory("xmd-nm-");
    const candidates = Array.from({ length: 8 }, (_, index) =>
      mapping({ nativeSessionId: `00000000-0000-4000-8000-00000000000${index}` }),
    );

    const settled = yield* all(
      candidates.map(function* (candidate) {
        try {
          return yield* createNativeSessionMappingStore(root).create(candidate);
        } catch (error) {
          if (error instanceof NativeSessionConflict) {
            return "refused" as const;
          }
          throw error;
        }
      }),
    );

    expect(yield* records(root)).toHaveLength(1);
    const retained = yield* createNativeSessionMappingStore(root).read(candidates[0]);
    const won = settled.filter((result) => result !== "refused");
    expect(won).toEqual([retained]);
  });

  it("NM5: a different identity for the same session is refused, not overwritten", function* () {
    const root = yield* useTempDirectory("xmd-nm-");
    const store = createNativeSessionMappingStore(root);
    const original = yield* store.create(mapping());

    let refused: unknown;
    try {
      yield* store.create(mapping({ nativeSessionId: "ffffffff-0000-4000-8000-000000000000" }));
    } catch (error) {
      refused = error;
    }

    expect(refused).toBeInstanceOf(NativeSessionConflict);
    expect(yield* store.read(original)).toEqual(original);
  });

  it("NM6: a different build for the same identity is a conflict", function* () {
    // Same session, same identity, different executable: adopting it would
    // silently rebind the session to a build that never created it.
    const root = yield* useTempDirectory("xmd-nm-");
    const store = createNativeSessionMappingStore(root);
    yield* store.create(mapping());

    let refused: unknown;
    try {
      yield* store.create(
        mapping({
          executableBinding: {
            ...BINDING,
            executableDigest: { algorithm: "sha256", value: "c".repeat(64) },
          },
        }),
      );
    } catch (error) {
      refused = error;
    }

    expect(refused).toBeInstanceOf(NativeSessionConflict);
  });

  it("NM7: different sessions do not collide", function* () {
    const root = yield* useTempDirectory("xmd-nm-");
    const store = createNativeSessionMappingStore(root);

    yield* store.create(mapping({ sessionKey: "session:a" }));
    yield* store.create(
      mapping({ sessionKey: "session:b", nativeSessionId: "11111111-0000-4000-8000-000000000000" }),
    );

    expect(yield* records(root)).toHaveLength(2);
  });

  it("NM8: a session name cannot decide where its record goes", function* () {
    // The record is named by digest, so a separator or a traversal segment in
    // an authored session name reaches no other session's record and no path
    // outside the store.
    const root = yield* useTempDirectory("xmd-nm-");
    const store = createNativeSessionMappingStore(root);

    yield* store.create(mapping({ sessionKey: "../../escaped" }));

    const written = yield* records(root);
    expect(written).toHaveLength(1);
    expect(written[0]).toMatch(/^[0-9a-f]{64}\.json$/);
  });

  it("NM9: the record is private and leaves no candidate behind", function* () {
    const root = yield* useTempDirectory("xmd-nm-");
    const store = createNativeSessionMappingStore(root);
    const written = yield* store.create(mapping());

    const entries = yield* until(readdir(root));
    expect(entries.filter((entry) => entry.includes("candidate"))).toEqual([]);
    const info = yield* until(stat(path.join(root, entries[0])));
    expect(info.mode & 0o777).toBe(0o600);
    expect(written.executableBinding).toBeDefined();
  });

  it("NM10: nothing retained names a path", function* () {
    const root = yield* useTempDirectory("xmd-nm-");
    const store = createNativeSessionMappingStore(root);
    yield* store.create(mapping());

    const entries = yield* until(readdir(root));
    const text = yield* until(readFile(path.join(root, entries[0]), "utf8"));

    // The binding is a version and a digest precisely so this file can be
    // moved, copied and read on another host without describing this one.
    expect(text).not.toContain("/");
    expect(JSON.parse(text)).toEqual(mapping());
  });

  it("NM11: a partial or unknown record fails closed rather than being repaired", function* () {
    const complete = mapping();
    const cases: Array<[string, unknown]> = [
      ["a client-allocated record with no binding", { ...complete, executableBinding: undefined }],
      [
        "a provider-returned record carrying a binding",
        {
          ...complete,
          identityProvenance: "provider-returned",
        },
      ],
      ["an unknown mapping schema", { ...complete, schema: "native-session-mapping.v2" }],
      [
        "an unknown binding schema",
        {
          ...complete,
          executableBinding: { ...BINDING, schema: "executable-build.v2" },
        },
      ],
      [
        "a truncated digest",
        {
          ...complete,
          executableBinding: {
            ...BINDING,
            executableDigest: { algorithm: "sha256", value: "abc" },
          },
        },
      ],
      ["a missing identity", { ...complete, nativeSessionId: "" }],
      ["a missing instruction digest", { ...complete, instructionsDigest: "" }],
      ["an unknown provenance", { ...complete, identityProvenance: "assumed" }],
    ];

    expect(cases.map(([name, value]) => [name, parseNativeSessionMapping(value)])).toEqual(
      cases.map(([name]) => [name, undefined]),
    );
  });

  it("NM12: an unreadable retained record refuses instead of allocating a replacement", function* () {
    // The dangerous repair: treating a damaged record as absent and allocating
    // a second identity for a session that already has one.
    const root = yield* useTempDirectory("xmd-nm-");
    const store = createNativeSessionMappingStore(root);
    const key = mapping();
    yield* store.create(key);
    const entries = yield* until(readdir(root));
    yield* until(writeFile(path.join(root, entries[0]), "{ not json"));

    let refused: unknown;
    try {
      yield* store.read(key);
    } catch (error) {
      refused = error;
    }

    expect(refused).toBeInstanceOf(NativeSessionConflict);
  });
});
