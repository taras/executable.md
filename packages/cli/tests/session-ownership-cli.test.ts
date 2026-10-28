import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { useTempDirectory } from "@executablemd/test-support/temp";
import { cliRuntime, runCli } from "@executablemd/test-support/launch";
import { ensureDir, writeTextFile, readTextFile } from "@effectionx/fs";
import { chmod, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createContext, ensure, scoped, until, Ok, Err, type Operation } from "effection";
import {
  agentSessionKeyDigest,
  AgentSessionOwnershipError,
  serializeAgentSessionOwnership,
  parseAgentSessionOwnership,
} from "@executablemd/runtime";
import type {
  AgentSessionOwnershipAdministration,
  AgentSessionOwnershipRecord,
} from "@executablemd/runtime";
import { runXmd } from "../src/cli.ts";
import { SOURCE_UPGRADE } from "./support/upgrade-assembly.ts";

const D = agentSessionKeyDigest({
  provider: "acpx",
  agent: "poison-command",
  sessionKey: "fixture-only",
});
const R = "a".repeat(64);
const record: AgentSessionOwnershipRecord = {
  release: "none",
  lastForcedRecovery: null,
  keyDigest: D,
  state: "active",
  ownerKind: "prompt",
  operationId: "fixture-abandoned",
};
const ExitContext = createContext<(value: { status: number }) => Operation<void>>("exit");

function invoke(args: string[], administration?: AgentSessionOwnershipAdministration) {
  return scoped(function* () {
    let status = 0;
    let touched = 0;
    const stdout: string[] = [];
    const stderr: string[] = [];
    const log = console.log;
    const warn = console.error;
    yield* ensure(() => {
      console.log = log;
      console.error = warn;
    });
    console.log = (text) => {
      stdout.push(String(text));
    };
    console.error = (text) => {
      stderr.push(String(text));
    };
    yield* ExitContext.set(function* (value) {
      status = value.status;
    });
    function* forbidden(): Operation<never> {
      touched++;
      throw new Error("session reached an unrelated host capability");
    }
    yield* runXmd(
      args,
      forbidden,
      SOURCE_UPGRADE,
      forbidden,
      forbidden,
      forbidden,
      {
        ownershipAdministration: administration,
        advertiseNativeLaunch: [],
        advertiseClientNativeAttachment: [],
        get coordinator(): never {
          touched++;
          throw new Error("provider assembly reached");
        },
      },
      { select: forbidden, install: forbidden },
    );
    return { status, stdout, stderr, touched };
  });
}

describe("Session ownership command", () => {
  it("SO1: runXmd routes exact capabilities before stdin, document/plugin, service, workflow, REPL or provider selection", function* () {
    const calls: unknown[] = [];
    const admin: AgentSessionOwnershipAdministration = {
      *inspectOwnership(keyDigest) {
        calls.push(["inspect", keyDigest]);
        return Ok({ keyDigest, recordRevision: R, record });
      },
      *forceRecoverOwnership(request) {
        calls.push(["force", request]);
        return Ok({
          keyDigest: request.keyDigest,
          previousRecordRevision: request.expectedRevision,
          recordRevision: R,
          recoveryId: "00000000-0000-4000-8000-000000000001",
          release: "forced",
          backendQuiescenceProved: false,
          interruptedOutcome: "unknown",
          providerRequestSent: false,
        });
      },
    };
    const inspect = yield* invoke(
      [
        "session",
        "ownership",
        "--provider=acpx",
        "--agent-command",
        "poison-command",
        "--session-key=fixture-only",
        "--json",
      ],
      admin,
    );
    expect(inspect.status).toBe(0);
    expect(inspect.touched).toBe(0);
    expect(calls).toEqual([["inspect", D]]);
    expect(JSON.parse(inspect.stdout[0]!)).toEqual({
      schema: "agent-session-ownership-inspection",
      keyDigest: D,
      recordRevision: R,
      record,
    });
    const forced = yield* invoke(
      ["session", "recover", `--key-digest=${D}`, `--expect=${R}`, "--force", "--json"],
      admin,
    );
    expect(forced.status).toBe(0);
    expect(forced.touched).toBe(0);
    expect(calls[1]).toEqual(["force", { keyDigest: D, expectedRevision: R, force: true }]);
    expect(JSON.parse(forced.stdout[0]!)).toMatchObject({
      schema: "agent-session-force-recovery",
      release: "forced",
      backendQuiescenceProved: false,
      interruptedOutcome: "unknown",
      providerRequestSent: false,
    });
    for (const args of [["--help"], ["ownership", "--help"], ["recover", "--help"]]) {
      const result = yield* invoke(["session", ...args]);
      expect(result.status).toBe(0);
      expect(result.touched).toBe(0);
      expect(result.stdout.join()).toContain("UNKNOWN");
    }
  });

  it("SO2: malformed lines refuse before capability access; absence is unsupported", function* () {
    let calls = 0;
    const admin: AgentSessionOwnershipAdministration = {
      *inspectOwnership() {
        calls++;
        throw new Error("grammar touched administration");
      },
      *forceRecoverOwnership() {
        calls++;
        throw new Error("grammar touched administration");
      },
    };
    for (const args of [
      [],
      ["ownership"],
      ["ownership", "--key-digest", "ABC"],
      ["ownership", "--key-digest", D, "--key-digest", D],
      ["ownership", "--key-digest", D, "--provider", "acpx"],
      ["ownership", "--provider", "acpx", "--session-key", "K"],
      ["ownership", "--key-digest", D, "--force"],
      ["ownership", "--key-digest", D, "--expect", R],
      ["ownership", "--key-digest", D, "--root", "/fixture"],
      ["ownership", "--key-digest", D, "extra"],
      ["ownership", "--key-digest="],
      ["ownership", "--provider=", "--agent-command=A", "--session-key=K"],
      ["ownership", "--key-digest", D, "--json=true"],
      ["recover", "--key-digest", D, "--expect", R],
      ["recover", "--key-digest", D, "--force"],
      ["recover", "--key-digest", D, "--expect", R, "--force=true"],
      ["recover", "--provider=P", "--agent-command=A", "--session-key=K", "--expect", R, "--force"],
      ["ownership", "--plugin=poison.ts", "--json"],
      ["ownership", "--key-digest", D, "--json", "--json"],
      ["recover", "--key-digest", D, "--expect", R.toUpperCase(), "--force"],
    ]) {
      const result = yield* invoke(["session", ...args], admin);
      expect([args, result.status, result.touched]).toEqual([args, 1, 0]);
    }
    expect(calls).toBe(0);
    const unsupported = yield* invoke(["session", "ownership", "--key-digest", D, "--json"]);
    expect(JSON.parse(unsupported.stderr[0]!)).toEqual({
      schema: "agent-session-ownership-error",
      code: "unsupported-capability",
      message: "this host cannot administer session ownership",
      keyDigest: D,
    });
    const uncertain = yield* invoke(
      ["session", "recover", "--key-digest", D, "--expect", R, "--force", "--json"],
      {
        ...admin,
        *forceRecoverOwnership() {
          return Err(
            new AgentSessionOwnershipError("publication-unknown", {
              cause: new Error("private fixture path"),
            }),
          );
        },
      },
    );
    expect(JSON.parse(uncertain.stderr[0]!)).toMatchObject({
      code: "publication-unknown",
      applied: "unknown",
    });
    expect(uncertain.stderr.join()).not.toContain("private fixture path");
  });

  it("SO3: the actual command inspects and forces only a seeded isolated HOME, with no provider or document effects", function* () {
    const home = yield* useTempDirectory("xmd-ownership-home-");
    const work = yield* useTempDirectory("xmd-ownership-work-");
    const ownership = join(home, ".acpx", "xmd-native-sessions", "v1", "ownership");
    yield* ensureDir(ownership);
    yield* until(chmod(ownership, 0o700));
    const path = join(ownership, D + ".json");
    const text = serializeAgentSessionOwnership(record);
    yield* writeTextFile(path, text);
    yield* until(chmod(path, 0o600));
    const revision = createHash("sha256").update(text).digest("hex");
    const poison = join(work, "poison.cjs");
    const contact = join(work, "provider-contact");
    const effect = join(work, "document-effect");
    yield* writeTextFile(
      poison,
      `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(contact)},'contacted');process.exit(1);\n`,
    );
    yield* until(chmod(poison, 0o755));
    yield* writeTextFile(
      join(home, ".acpx", "config.json"),
      JSON.stringify({ agents: { poison: { command: poison } } }),
    );
    yield* writeTextFile(
      join(work, "poison.ts"),
      `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(effect)}, "unexpected plugin effect");`,
    );
    yield* writeTextFile(
      join(work, "session"),
      `# Poison document\n<WriteFile path=${JSON.stringify(effect)}>unexpected</WriteFile>\n`,
    );
    const options = {
      cwd: work,
      env: { HOME: home, XDG_DATA_HOME: join(home, "share"), DEFAULT_AGENT_NAME: "poison" },
      inheritEnv: false,
    };
    const inspected = yield* runCli(
      ["session", "ownership", "--key-digest", D, "--json"],
      options,
    ).join();
    if (cliRuntime() !== "deno") {
      expect(inspected.code).toBe(1);
      expect(inspected.stderr).toContain("unsupported-capability");
      const recovered = yield* runCli(
        ["session", "recover", "--key-digest", D, "--expect", revision, "--force", "--json"],
        options,
      ).join();
      expect(recovered.code).toBe(1);
      expect(recovered.stderr).toContain("unsupported-capability");
      expect(yield* readTextFile(path)).toBe(text);
    } else {
      expect(inspected.code).toBe(0);
      expect(JSON.parse(inspected.stdout)).toEqual({
        schema: "agent-session-ownership-inspection",
        keyDigest: D,
        recordRevision: revision,
        record,
      });
      expect(yield* readTextFile(path)).toBe(text);
      expect((yield* until(stat(path))).mode & 0o777).toBe(0o600);
      for (const args of [
        ["--expect", revision],
        ["--expect", "0".repeat(64), "--force"],
      ]) {
        const result = yield* runCli(
          ["session", "recover", "--key-digest", D, ...args, "--json"],
          options,
        ).join();
        expect(result.code).toBe(1);
        expect(yield* readTextFile(path)).toBe(text);
      }
      const force = yield* runCli(
        ["session", "recover", "--key-digest", D, "--expect", revision, "--force", "--json"],
        options,
      ).join();
      expect(force.code).toBe(0);
      const receipt = JSON.parse(force.stdout);
      expect(Object.keys(receipt).sort()).toEqual(
        [
          "schema",
          "keyDigest",
          "previousRecordRevision",
          "recordRevision",
          "recoveryId",
          "release",
          "backendQuiescenceProved",
          "interruptedOutcome",
          "providerRequestSent",
        ].sort(),
      );
      expect(receipt).toMatchObject({
        schema: "agent-session-force-recovery",
        previousRecordRevision: revision,
        release: "forced",
        backendQuiescenceProved: false,
        interruptedOutcome: "unknown",
        providerRequestSent: false,
      });
      const bytes = yield* readTextFile(path);
      expect(receipt.recordRevision).toBe(createHash("sha256").update(bytes).digest("hex"));
      expect(parseAgentSessionOwnership(JSON.parse(bytes))).toMatchObject({
        state: "idle",
        release: "forced",
        lastForcedRecovery: { recoveryId: receipt.recoveryId },
      });
    }
    const plugin = yield* runCli(
      ["session", "ownership", "--key-digest", D, "--plugin", join(work, "poison.ts")],
      options,
    ).join();
    expect(plugin.code).toBe(1);
    expect((yield* until(readdir(work))).sort()).toEqual(["poison.cjs", "poison.ts", "session"]);
    // Sorted, like the directory above it: what this asserts is exactly which
    // names are there, and a directory does not promise the order it hands
    // them back in. Measured, one runner enumerated these two the other way
    // round and the membership was the membership either way.
    expect((yield* until(readdir(join(home, ".acpx")))).sort()).toEqual([
      "config.json",
      "xmd-native-sessions",
    ]);
    const dirs = yield* until(readdir(join(home, ".acpx", "xmd-native-sessions", "v1")));
    expect(dirs.includes("routes")).toBe(false);
    expect((yield* until(readdir(home))).includes(".xmd")).toBe(false);
  });
});
