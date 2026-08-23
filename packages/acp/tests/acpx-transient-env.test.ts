/**
 * Tier TE — the vendored ACPX transient agent environment
 * (packages/acp/vendor/acpx/PROVENANCE.md).
 *
 * Native session launch binds one exact Claude build to both owners of a
 * session, and the ACP adapter learns which one from `CLAUDE_CODE_EXECUTABLE`
 * in its own environment. ACPX 0.12.0 could only deliver that by persisting it
 * into a session record or by mutating this process's environment, and the
 * #519 contract forbids both — so the vendored copy adds one transient input.
 *
 * These tests spawn a real child. The agent command resolves to a fake
 * executable that records the environment it was given and exits, so what is
 * proven is that the value reached an actual agent process, not that a function
 * was called with it. The fake is not an ACP agent, so ACPX's handshake fails
 * afterwards — which is irrelevant: the child, and its environment, already
 * happened.
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, scoped, until } from "effection";
import type { Operation } from "effection";
import { ensureDir, readTextFile, rm, writeTextFile } from "@effectionx/fs";
import { chmod } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import process from "node:process";
import { createAcpRuntime } from "../src/acpx-runtime.ts";
import type { AcpAgentRegistry, AcpSessionRecord, AcpSessionStore } from "../src/acpx-runtime.ts";

/** A stand-in for a bound executable; never a real path on this machine. */
const BOUND = "/nonexistent/bound/claude/2.1.235";

interface World {
  dir: string;
  log: string;
  registry: AcpAgentRegistry;
  store: AcpSessionStore & { records: Map<string, AcpSessionRecord> };
}

/**
 * A fake agent that records the one environment value under test and exits.
 *
 * It records absence explicitly, so a child that was spawned without the
 * binding is distinguishable from a child that never spawned at all.
 */
function* useWorld(): Operation<World> {
  const dir = path.join(os.tmpdir(), `xmd-te-${randomUUID()}`);
  yield* ensureDir(dir);
  yield* ensure(() => rm(dir, { recursive: true, force: true }));

  const log = path.join(dir, "env.log");
  const agent = path.join(dir, "fake-agent");
  yield* writeTextFile(
    agent,
    [
      "#!/usr/bin/env node",
      'const fs = require("node:fs");',
      `fs.appendFileSync(${JSON.stringify(log)}, (process.env.CLAUDE_CODE_EXECUTABLE ?? "<unset>") + "\\n");`,
      "process.exit(0);",
      "",
    ].join("\n"),
  );
  yield* until(chmod(agent, 0o755));

  const records = new Map<string, AcpSessionRecord>();
  return {
    dir,
    log,
    registry: { resolve: () => agent, list: () => ["claude"] },
    store: {
      records,
      load: (id) => Promise.resolve(records.get(id)),
      save: (record) => {
        records.set(record.acpxRecordId, record);
        return Promise.resolve();
      },
    },
  };
}

/** What the fake agent children recorded, in spawn order. */
function* recorded(world: World): Operation<string[]> {
  try {
    return (yield* readTextFile(world.log)).split("\n").filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

function runtimeFor(world: World, agentProcessEnv?: Record<string, string>) {
  return createAcpRuntime({
    cwd: world.dir,
    sessionStore: world.store,
    agentRegistry: world.registry,
    permissionMode: "deny-all",
    nonInteractivePermissions: "deny",
    ...(agentProcessEnv ? { agentProcessEnv } : {}),
  });
}

/** Reach a child however the call settles; the handshake is not under test. */
function* attempt<T>(op: () => Operation<T>): Operation<void> {
  try {
    yield* op();
  } catch {
    // The fake agent speaks no ACP. The spawn is the observation.
  }
}

describe(
  "Tier TE — vendored ACPX transient agent environment",
  {
    sanitizeOps: false,
    sanitizeResources: false,
  },
  () => {
    it("TE1: the availability probe's child receives the bound executable", function* () {
      const world = yield* useWorld();
      const runtime = runtimeFor(world, { CLAUDE_CODE_EXECUTABLE: BOUND });

      yield* attempt(() => until(runtime.doctor()));

      expect(yield* recorded(world)).toContain(BOUND);
    });

    it("TE2: the session child receives it too", function* () {
      const world = yield* useWorld();
      const runtime = runtimeFor(world, { CLAUDE_CODE_EXECUTABLE: BOUND });

      yield* attempt(() =>
        until(
          runtime.ensureSession({
            sessionKey: "te-bound",
            agent: "claude",
            mode: "persistent",
            cwd: world.dir,
          }),
        ),
      );

      const seen = yield* recorded(world);
      expect(seen.length).toBeGreaterThan(0);
      // Every child of a bound runtime is bound. One unbound child is one
      // chance to resume a session with the wrong build.
      expect(seen.every((entry) => entry === BOUND)).toBe(true);
    });

    it("TE3: an unbound runtime passes nothing, so absence is observable", function* () {
      const world = yield* useWorld();
      const runtime = runtimeFor(world);

      yield* attempt(() => until(runtime.doctor()));

      const seen = yield* recorded(world);
      expect(seen.length).toBeGreaterThan(0);
      expect(seen).not.toContain(BOUND);
    });

    it("TE4: the binding never reaches a session record", function* () {
      const world = yield* useWorld();
      const runtime = runtimeFor(world, { CLAUDE_CODE_EXECUTABLE: BOUND });

      yield* attempt(() =>
        until(
          runtime.ensureSession({
            sessionKey: "te-record",
            agent: "claude",
            mode: "persistent",
            cwd: world.dir,
          }),
        ),
      );

      // An invocation-local path in a durable record would outlive the
      // invocation that was allowed to know it.
      const persisted = JSON.stringify([...world.store.records.values()]);
      expect(persisted).not.toContain(BOUND);
      expect(persisted).not.toContain("CLAUDE_CODE_EXECUTABLE");
    });

    it("TE5: the binding never reaches this process's environment", function* () {
      const before = process.env.CLAUDE_CODE_EXECUTABLE;
      yield* scoped(function* () {
        const world = yield* useWorld();
        const runtime = runtimeFor(world, { CLAUDE_CODE_EXECUTABLE: BOUND });
        yield* attempt(() => until(runtime.doctor()));
      });

      // Mutating the parent environment would bind every unrelated child of this
      // process too, which is the other way ACPX 0.12.0 could have delivered it.
      expect(process.env.CLAUDE_CODE_EXECUTABLE).toBe(before);
    });
  },
);
