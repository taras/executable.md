/**
 * Tier WSR — a run restarts, and each Session site comes back to its own
 * conversation (specs/workflow-workspace-spec.md §8.5).
 *
 * The whole boundary, once: a real Markdown document with two same-named
 * `<Session>` sites, the real workflow attachment, the real mapping table in the
 * run's own database, and a second attachment over what the first left behind.
 * Only the agent process is substituted.
 *
 * WAP7 proves two sibling sites place two identities while a document is
 * running, and WSL proves the resolution rules in isolation. Neither crosses
 * this boundary: document, to committed row, to a new attachment reading it
 * back. That crossing is what a restart is.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { scoped, spawn, until, suspend, withResolvers } from "effection";
import type { Operation } from "effection";
import { readdir, ensureDir, exists, readTextFile, writeTextFile } from "@effectionx/fs";
import { chmod, symlink } from "node:fs/promises";
import process from "node:process";
import { exec, useQuietProcessOutput } from "@executablemd/runtime";
import { createAcpRuntime, createAcpxSessionStore } from "@executablemd/acp";
import { withCertificationFixture } from "../../acp/tests/certification-fixture.ts";
import type { ExecutionInstallation } from "@executablemd/core/host";
import { createEmbeddedAdapters } from "@executablemd/acp/embedded-adapters";
import { DatabaseSync } from "node:sqlite";
import { dirname, join, relative as relativePath } from "node:path";
import { fileURLToPath } from "node:url";
import {
  registerComponents,
  agentIdentityComponents,
  collect,
  retainedSource,
} from "@executablemd/core";
import { executeInstalled } from "@executablemd/core/host";
import type { Json } from "@executablemd/durable-streams";
import { API, useHostFiles } from "@executablemd/runtime";
import type { WorkflowRunDatabase } from "@executablemd/workflow";
import { withWorkflowWorkspace, workflowRunPath } from "@executablemd/workflow/deno";
import { useWorkflowAgentProfile } from "../src/workflow-agent.ts";
import type { WorkflowAgentProfileOptions } from "../src/workflow-agent.ts";
import { createFakeAcp, makeStore, tripwireAcp } from "./support/fake-acp.ts";
import type { FakeAcp } from "./support/fake-acp.ts";
import { createRun, useStorageRoot, withStorage } from "./support/workflow-run.ts";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "workflow-agent");

function* documentSource(name = "sibling-sessions.md"): Operation<string> {
  return yield* readTextFile(join(FIXTURES, name));
}

interface Attempt {
  output?: Json;
  failure?: string;
}

/**
 * One attachment over `database`, running the fixture.
 *
 * The contextual working directory is somewhere the run may not reach, and a
 * host Files provider sits outside the attachment, so anything that fell through
 * to the caller's filesystem would be visible rather than silent.
 */
function attach(
  root: string,
  database: WorkflowRunDatabase,
  source: string,
  options: {
    readonly createRuntime: WorkflowAgentProfileOptions["createRuntime"];
    readonly sessionStore: WorkflowAgentProfileOptions["sessionStore"];
    readonly defaultAgent?: string;
    readonly installation?: ExecutionInstallation;
  },
): Operation<Attempt> {
  return scoped(function* () {
    yield* API.Env.around(
      {
        // deno-lint-ignore require-yield
        *cwd(): Operation<string> {
          return "/nowhere-the-workflow-may-reach";
        },
      },
      { at: "min" },
    );
    yield* useHostFiles();
    let output: Json | undefined;
    let failure: string | undefined;
    try {
      output = yield* withWorkflowWorkspace(
        database,
        scoped(function* () {
          return yield* collect(
            yield* executeInstalled(
              {
                ...retainedSource("workflows/sibling-sessions.md", source),
                stream: database.journal,
              },
              // `<Session>` names durable work after its own invocation, so the
              // host declares it to the execution rather than registering it.
              [
                { components: agentIdentityComponents() },
                ...(options.installation === undefined ? [] : [options.installation]),
              ],
            ),
          );
        }),
        {
          agent: (attachment) =>
            useWorkflowAgentProfile({
              agentProcessEnv: function* () {
                return undefined;
              },
              root,
              attachment,
              defaultAgent: options.defaultAgent ?? "codex",
              ...options,
            }),
        },
      );
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    return {
      ...(output === undefined ? {} : { output }),
      ...(failure === undefined ? {} : { failure }),
    };
  });
}

/** The distinct session keys the fake was asked to establish. */
function established(fake: FakeAcp): string[] {
  return [...new Set(fake.ensured.map((input) => input.sessionKey))].sort();
}

/** One retained mapping, as a second connection sees it. */
interface MappingRow {
  readonly sessionIdentity: string;
  readonly kind: string;
  readonly value: string;
}

/**
 * The rows `agent_sessions` actually holds.
 *
 * Read on a connection of its own, so what is asserted is what committed rather
 * than what this process believes it wrote.
 */
function mappingRows(path: string): MappingRow[] {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    return database
      .prepare(
        "SELECT session_identity, assertion_kind, assertion_value FROM agent_sessions " +
          "ORDER BY session_identity",
      )
      .all()
      .map((row) => ({
        sessionIdentity: String(row["session_identity"]),
        kind: String(row["assertion_kind"]),
        value: String(row["assertion_value"]),
      }));
  } finally {
    database.close();
  }
}

/** Every provider-native identity the substituted store currently holds. */
function storeAssertions(store: ReturnType<typeof makeStore>): string[] {
  return [...store.records.values()]
    .flatMap((record) => (record.agentSessionId === undefined ? [] : [record.agentSessionId]))
    .sort();
}

describe("Tier WSR — a restart reattaches each Session site", () => {
  it("WSR1: two same-named sites keep their own asserted identities across a restart", function* () {
    const root = yield* useStorageRoot();
    const source = yield* documentSource();

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      // One store across both attachments: the provider keeps its sessions
      // across processes, so a fresh one would be a provider that forgot rather
      // than a process that restarted.
      const store = makeStore();

      // The first attachment is interrupted while the second site's turn is in
      // flight. Both sites have placed and both mappings have committed by then:
      // a mapping commits after the backend accepts that site's first turn and
      // before anything the turn produced is exposed, so a second turn whose
      // events are being read has already been committed. What the interruption
      // leaves unfinished is the turn, not the retention.
      const interrupted = createFakeAcp();
      interrupted.script({ reply: "the first reviewer saw the checklist" });
      interrupted.script({ reply: "", manual: true });

      const first = yield* spawn(() =>
        attach(root, database, source, {
          createRuntime: interrupted.create,
          sessionStore: store,
        }),
      );
      // Not `startedTurns`: a turn can be requested and never accepted, and it
      // is acceptance the mapping waits on.
      yield* interrupted.consumedTurns(2);
      yield* first.halt();

      const before = established(interrupted);
      // Two sites, two sessions — with one authored name between them.
      expect(before).toHaveLength(2);

      // Two rows in the run's own database, one per site, each carrying the
      // tagged identity its provider asserted. This is the retention the
      // restart below has to resolve from; without it the restart could still
      // reconcile from the provider store and prove nothing.
      const rows = mappingRows(workflowRunPath(root, database.record.runId));
      expect(rows).toHaveLength(2);
      expect(new Set(rows.map((row) => row.sessionIdentity)).size).toBe(2);
      expect(rows.map((row) => row.kind)).toEqual(["acpx.agentSessionId", "acpx.agentSessionId"]);
      // And what the database holds is what the provider actually asserted —
      // compared against the store rather than re-derived from the keys under
      // test, which would assert nothing.
      expect(rows.map((row) => row.value).sort()).toEqual(storeAssertions(store));

      // The restart: a new attachment over the same run and the same provider
      // store, with a provider that answers the turn the first attempt never
      // finished.
      const resumed = createFakeAcp();
      resumed.script({ reply: "the second reviewer saw the release notes" });
      const second = yield* attach(root, database, source, {
        createRuntime: resumed.create,
        sessionStore: store,
      });

      expect(second.failure).toBe(undefined);

      // Exactly the two sites the first attachment established — not a subset,
      // and not one of them twice. Each site resolved to its own mapping.
      expect(established(resumed)).toEqual(before);

      // The rows are unchanged: reattachment compared and continued rather than
      // replacing either identity.
      expect(mappingRows(workflowRunPath(root, database.record.runId))).toEqual(rows);
    });
  });

  it("WSR2: a replayed site asks the provider for nothing", function* () {
    const root = yield* useStorageRoot();
    const source = yield* documentSource();

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const store = makeStore();

      const live = createFakeAcp();
      live.script({ reply: "the first reviewer saw the checklist" });
      live.script({ reply: "the second reviewer saw the release notes" });
      const complete = yield* attach(root, database, source, {
        createRuntime: live.create,
        sessionStore: store,
      });
      expect(complete.failure).toBe(undefined);
      expect(new Set(established(live)).size).toBe(2);

      // Both sites are recorded, so a further attachment restores them and
      // reaches no provider at all — not even to create a runtime.
      const reached: string[] = [];
      const replay = yield* attach(root, database, source, {
        createRuntime: tripwireAcp((what) => reached.push(what)),
        sessionStore: store,
      });
      expect(replay.failure).toBe(undefined);
      expect(reached).toEqual([]);
    });
  });
});

/**
 * Tier WSA — Claude is ACP-only here (specs/workflow-workspace-spec.md §8.5).
 *
 * Claude is the agent whose ordinary-`xmd run` sessions belong to a machine:
 * owned across processes, with their construction written down and the build
 * behind them observed. A workflow session belongs to a run instead, and this
 * profile says so explicitly rather than inheriting the package's advertised
 * sets by omission — which would make this document demand ownership and a
 * route that a run has no way to give it.
 *
 * The proof is that it works: the real attachment, the real `agent_sessions`
 * table, a restart onto the same assertion, and only the agent process
 * substituted.
 */
describe("Tier WSA — the workflow profile serves Claude over ACP alone", () => {
  it("WSR3: a Claude session is retained and reattached with no machine-wide account", function* () {
    const root = yield* useStorageRoot();
    const source = yield* documentSource("claude-session.md");

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const store = makeStore();

      // Interrupted while the second turn is in flight, exactly as WSR1 is:
      // the session has been established and its mapping committed by then, so
      // what the interruption leaves unfinished is the turn rather than the
      // retention — which is what gives the restart something to resolve from.
      const live = createFakeAcp();
      live.script({ reply: "the reviewer saw the release notes" });
      live.script({ reply: "", manual: true });

      const first = yield* spawn(() =>
        attach(root, database, source, {
          createRuntime: live.create,
          sessionStore: store,
          defaultAgent: "claude",
        }),
      );
      yield* live.startedTurns(2);
      yield* first.halt();

      // It ran at all. On a profile that had inherited the ordinary-run
      // advertisement this would have refused before contacting the agent,
      // because a workflow supplies no coordinator, no route store and no
      // executable observer.
      expect(established(live)).toHaveLength(1);

      // One row in the run's own database, carrying the identity the provider
      // asserted — the #549 mapping, unchanged.
      const runPath = workflowRunPath(root, database.record.runId);
      const rows = mappingRows(runPath);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.kind).toBe("acpx.agentSessionId");
      expect(rows.map((row) => row.value)).toEqual(storeAssertions(store));

      // The restart resolves from that row and continues the same conversation.
      const resumed = createFakeAcp();
      resumed.script({ reply: "and they recommended shipping it" });
      const second = yield* attach(root, database, source, {
        createRuntime: resumed.create,
        sessionStore: store,
        defaultAgent: "claude",
      });

      expect(second.failure).toBe(undefined);
      expect(established(resumed)).toEqual(established(live));
      // Compared and continued, never replaced.
      expect(mappingRows(runPath)).toEqual(rows);
    });
  });
});

function* hostClaudeWorkflow(
  mode: "path" | "missing" | "unlaunchable" | "explicit" | "invalid" | "confirmation",
): Operation<void> {
  const root = yield* useStorageRoot();
  const adapters = createEmbeddedAdapters(join(root, "adapters"));
  yield* adapters.materialize("claude");
  const modules = join(dirname(dirname(dirname(adapters.executablePath("claude")))), "..");
  const sdk = join(
    modules,
    "@anthropic-ai",
    `claude-agent-sdk-${process.platform}-${process.arch}`,
  );
  yield* ensureDir(sdk);
  const staleLog = join(root, "stale.log");
  const stale = join(sdk, "claude");
  yield* writeTextFile(
    join(sdk, "package.json"),
    JSON.stringify({
      name: `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`,
      version: "0.3.238",
    }),
  );
  yield* writeTextFile(stale, `#!/bin/sh\necho stale >> "${staleLog}"\nexit 1\n`);
  yield* until(chmod(stale, 0o755));
  const bin = join(root, "host bin");
  yield* ensureDir(bin);
  const host = join(bin, "claude");
  const log = join(root, "host.log");
  const pathLog = join(root, "path-candidate.log");
  const fixture = fileURLToPath(
    new URL("../../acp/tests/fixtures/fake-claude-cli.cjs", import.meta.url),
  );
  const fake = yield* readTextFile(fixture);
  const cli = `#!/usr/bin/env node\n${mode === "confirmation" ? 'process.env.FAKE_CLAUDE_CONFIRMATION = "failed";' : ""}\nprocess.env.FAKE_CLAUDE_LOG = ${JSON.stringify(log)};\nif (process.argv.includes("--version")) { console.log("unfamiliar development build"); process.exit(0); }\n${fake.replace(/^#!.*\n/, "")}`;
  if (mode !== "missing") {
    yield* writeTextFile(
      host,
      mode === "unlaunchable"
        ? "#!/nonexistent/hc-interpreter\n"
        : mode === "explicit"
          ? cli.replace(JSON.stringify(log), JSON.stringify(pathLog))
          : cli,
    );
    yield* until(chmod(host, 0o755));
  }
  const explicit = join(root, "selected claude.cjs");
  yield* writeTextFile(explicit, cli);
  yield* until(chmod(explicit, 0o755));
  const node = yield* scoped(function* () {
    yield* useQuietProcessOutput();
    return yield* exec({ command: ["node", "-p", "process.execPath"] });
  });
  expect(node.exitCode).toBe(0);
  yield* until(symlink(node.stdout.trim(), join(bin, "node")));
  const selected = mode === "explicit" ? explicit : mode === "invalid" ? join(root, "absent") : "";
  const child = yield* scoped(function* () {
    yield* useQuietProcessOutput();
    return yield* exec({
      command: [
        process.execPath,
        "run",
        "--allow-all",
        "--frozen",
        fileURLToPath(new URL("./fixtures/host-agent.ts", import.meta.url)),
        root,
      ],
      env: { PATH: bin, CLAUDE_CODE_EXECUTABLE: selected },
    });
  });
  expect({ exitCode: child.exitCode, stderr: child.stderr }).toEqual({ exitCode: 0, stderr: "" });
  const report = JSON.parse(yield* readTextFile(join(root, "report.json")));
  expect(yield* exists(staleLog)).toBe(false);
  expect(yield* exists(pathLog)).toBe(false);
  expect(process.env.CLAUDE_CODE_EXECUTABLE).not.toBe(host);
  expect(report.environmentPreserved).toBe(true);
  if (mode === "confirmation") {
    expect(report.failure).toBeDefined();
    expect(report.mappings).toEqual([]);
    expect(yield* readTextFile(log)).not.toContain('"type":"user"');
    return;
  }
  if (["missing", "invalid", "unlaunchable"].includes(mode)) {
    expect(report.failure).toContain("CLAUDE_CODE_EXECUTABLE");
    expect(report.failure).toContain("PATH");
    expect(report.failure).not.toContain(root);
    expect(report.mappings).toEqual([]);
    expect(yield* exists(log)).toBe(false);
    return;
  }
  if (report.failure !== undefined) {
    console.log(
      JSON.stringify({
        report,
        hostLog: yield* readTextFile(log),
        staleLaunched: yield* exists(staleLog),
      }),
    );
  }
  expect(report.failure).toBe(undefined);
  expect(report.output).toContain("answered");
  expect(report.mappings).toHaveLength(1);
  expect(report.mappings[0].assertion_kind).toBe("acpx.agentSessionId");
  expect(report.checkpoints.ok).toBe(true);
  expect(report.checkpoints.value).toHaveLength(1);
  expect(report.checkpoints.value[0].tokenValue).toBe(`uuid:${report.mappings[0].assertion_value}`);
  const calls = yield* readTextFile(log);
  expect(calls).toContain('"type":"control_request"');
  expect(calls).toContain("HC exact user prompt");
  const durable = JSON.stringify([
    report.mappings,
    report.journal,
    report.records,
    report.checkpoints,
  ]);
  expect(durable).not.toContain("CLAUDE_CODE_EXECUTABLE");
  expect(durable).not.toContain("session-start.js");
  expect(durable).not.toContain(host);
  expect(durable).not.toContain(explicit);
  expect(report.replayFailure).toBe(undefined);
  expect(report.replayOutput).toEqual(report.output);
}

describe("HC host Claude through the production workflow", () => {
  it("HC1/HC6: the host wins over the SDK and completed replay stays offline", () =>
    hostClaudeWorkflow("path"));
  it("HC2: a missing host refuses despite an SDK executable", () => hostClaudeWorkflow("missing"));
  it("HC2: an unlaunchable host refuses before a prompt", () => hostClaudeWorkflow("unlaunchable"));
  it("HC3: explicit host selection and an unfamiliar version work", () =>
    hostClaudeWorkflow("explicit"));
  it("HC3: an invalid explicit selection never falls back to PATH", () =>
    hostClaudeWorkflow("invalid"));
  it("HC HCI2: a failed lifecycle assertion publishes no production mapping or prompt", function* () {
    yield* hostClaudeWorkflow("confirmation");
  });
});

/** Every line one fake host App Server logged, in arrival order. */
function* hostRequests(log: string): Operation<Array<{ method?: string; params?: unknown }>> {
  if (!(yield* exists(log))) {
    return [];
  }
  return (yield* readTextFile(log))
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

type HostCodexMode =
  | "path"
  | "explicit"
  | "relative"
  | "bare"
  | "empty"
  | "missing"
  | "invalid"
  | "unlaunchable"
  | "effort"
  | "no-selector";

/**
 * One production workflow Prompt through the carried Codex adapter, with the
 * host CLI replaced by logging copies of the fake App Server. Which copy wrote
 * its log is which executable actually ran.
 */
function* hostCodexWorkflow(mode: HostCodexMode): Operation<void> {
  const root = yield* useStorageRoot();
  // Installed here, where npm is reachable: the run's PATH holds only the host.
  yield* createEmbeddedAdapters(join(root, "adapters")).materialize("codex");
  const bin = join(root, "host bin");
  yield* ensureDir(bin);
  const fixture = fileURLToPath(
    new URL("../../acp/tests/fixtures/fake-codex-app-server.cjs", import.meta.url),
  );
  const fake = (yield* readTextFile(fixture)).replace(/^#!.*\n/, "");
  const catalog = mode === "effort" ? "sol" : mode === "no-selector" ? "no-selector" : "";
  const host = (log: string): string =>
    [
      "#!/usr/bin/env node",
      `process.env.FAKE_CODEX_LOG = ${JSON.stringify(log)};`,
      `process.env.FAKE_CODEX_CATALOG = ${JSON.stringify(catalog)};`,
      'if (process.argv.includes("--version")) { console.log("unfamiliar development build"); process.exit(0); }',
      `require("node:fs").appendFileSync(${JSON.stringify(log)}, JSON.stringify({ launched: process.argv.slice(2) }) + "\\n");`,
      fake,
    ].join("\n");
  const pathLog = join(root, "path-host.log");
  const selectedLog = join(root, "selected-host.log");
  const pathHost = join(bin, "codex");
  if (mode !== "missing") {
    yield* writeTextFile(
      pathHost,
      mode === "unlaunchable" ? "#!/nonexistent/hc-interpreter\n" : host(pathLog),
    );
    yield* until(chmod(pathHost, 0o755));
  }
  const explicit = join(root, "selected codex.cjs");
  const relative = join(root, "tools", "codex");
  const bare = join(bin, "codex-selected");
  for (const selected of [explicit, relative, bare]) {
    yield* ensureDir(dirname(selected));
    yield* writeTextFile(selected, host(selectedLog));
    yield* until(chmod(selected, 0o755));
  }
  const node = yield* scoped(function* () {
    yield* useQuietProcessOutput();
    return yield* exec({ command: ["node", "-p", "process.execPath"] });
  });
  expect(node.exitCode).toBe(0);
  yield* until(symlink(node.stdout.trim(), join(bin, "node")));
  const override = {
    explicit,
    // A path selection, resolved against the host's own working directory.
    relative: relativePath(process.cwd(), relative),
    bare: "codex-selected",
    invalid: join(root, "absent"),
  }[mode as string];
  const attributes =
    mode === "effort" || mode === "no-selector" ? ' model="gpt-6.1-sol" effort="high"' : "";
  const child = yield* scoped(function* () {
    yield* useQuietProcessOutput();
    return yield* exec({
      command: [
        process.execPath,
        "run",
        "--allow-all",
        "--frozen",
        fileURLToPath(new URL("./fixtures/host-agent.ts", import.meta.url)),
        root,
        "codex",
        attributes,
      ],
      env: mode === "path" ? { PATH: bin } : { PATH: bin, CODEX_PATH: override ?? "" },
    });
  });
  expect({ exitCode: child.exitCode, stderr: child.stderr }).toEqual({ exitCode: 0, stderr: "" });
  const report = JSON.parse(yield* readTextFile(join(root, "report.json")));
  expect(report.environmentPreserved).toBe(true);
  const selectedRan = ["explicit", "relative", "bare"].includes(mode);
  if (["missing", "invalid", "unlaunchable"].includes(mode)) {
    expect(report.failure).toContain("CODEX_PATH");
    expect(report.failure).toContain("PATH");
    expect(report.failure).not.toContain(root);
    expect(report.mappings).toEqual([]);
    expect(yield* exists(pathLog)).toBe(false);
    expect(yield* exists(selectedLog)).toBe(false);
    return;
  }
  const ran = yield* hostRequests(selectedRan ? selectedLog : pathLog);
  expect(yield* exists(selectedRan ? pathLog : selectedLog)).toBe(false);
  // The availability probe and the live runtime each start the selected
  // host's App Server; the launchability probe exits before logging.
  const launches = ran.filter((entry) => "launched" in entry);
  expect(launches.length).toBeGreaterThan(0);
  expect(launches.every((entry) => JSON.stringify(entry) === '{"launched":["app-server"]}')).toBe(
    true,
  );
  const turns = ran.filter((entry) => entry.method === "turn/start");
  if (mode === "no-selector") {
    expect(report.failureMembers).toEqual([
      'Effort choices are unavailable for model "gpt-6.1-sol".',
    ]);
    expect(report.mappings).toEqual([]);
    expect(turns).toEqual([]);
    return;
  }
  expect(report.failure).toBe(undefined);
  expect(turns).toHaveLength(1);
  if (mode === "effort") {
    expect(turns[0]?.params).toMatchObject({ model: "gpt-6.1-sol", effort: "high" });
  }
  expect(report.mappings).toHaveLength(1);
  expect(report.checkpoints.ok).toBe(true);
  expect(report.checkpoints.value).toHaveLength(1);
  const durable = JSON.stringify([
    report.mappings,
    report.journal,
    report.records,
    report.checkpoints,
  ]);
  expect(durable).not.toContain("CODEX_PATH");
  expect(durable).not.toContain(pathHost);
  expect(durable).not.toContain(explicit);
  expect(durable).not.toContain(relative);
  expect(report.replayFailure).toBe(undefined);
  expect(report.replayOutput).toEqual(report.output);
}

describe("H host Codex through the production workflow", () => {
  it("H1/H3: the PATH host runs and completed replay stays offline", () =>
    hostCodexWorkflow("path"));
  it("H1: an empty CODEX_PATH uses the PATH host", () => hostCodexWorkflow("empty"));
  it("H1: an explicit CODEX_PATH wins over the PATH host", () => hostCodexWorkflow("explicit"));
  it("H1: a relative CODEX_PATH resolves against the host directory", () =>
    hostCodexWorkflow("relative"));
  it("H1: a bare CODEX_PATH command searches the host PATH", () => hostCodexWorkflow("bare"));
  it("H2: a missing host refuses before a prompt", () => hostCodexWorkflow("missing"));
  it("H2: an invalid explicit selection never falls back to PATH", () =>
    hostCodexWorkflow("invalid"));
  it("H2: an unlaunchable host refuses before a prompt", () => hostCodexWorkflow("unlaunchable"));
  it("H4: the host's model and effort are applied and verified before its turn", () =>
    hostCodexWorkflow("effort"));
  it("H4: a host without the model's effort selector refuses with no turn", () =>
    hostCodexWorkflow("no-selector"));
});

describe("workflow ACP loading identity", { sanitizeOps: false, sanitizeResources: false }, () => {
  for (const differentKind of [false, true]) {
    it(`retains the ACP identity and ${differentKind ? "refuses a changed kind" : "loads it on restart"}`, function* () {
      yield* withCertificationFixture(function* (f) {
        const root = yield* useStorageRoot();
        yield* withStorage(root, function* () {
          const database = yield* createRun();
          const store = createAcpxSessionStore(join(f.dir, "store"));
          const gate = withResolvers<void>();
          const source =
            '<Session name="standard"><Prompt text="seed:workflow-marker" /><Gate /><Prompt text="recall" /></Session>';
          let held = true;
          const installation: ExecutionInstallation = {
            *install() {
              yield* registerComponents([
                {
                  name: "Gate",
                  origin: "test://continuation-gate",
                  props: { type: "object", properties: {}, additionalProperties: false },
                  *fn() {
                    if (held) {
                      gate.resolve();
                      yield* suspend();
                    }
                    return "";
                  },
                },
              ]);
            },
          };
          const options = {
            createRuntime: createAcpRuntime,
            sessionStore: store,
            defaultAgent: f.command("standard"),
            installation,
          };
          const first = yield* spawn(() => attach(root, database, source, options));
          yield* gate.operation;
          yield* first.halt();
          const rows = mappingRows(workflowRunPath(root, database.record.runId));
          expect(rows).toHaveLength(1);
          expect(rows[0]?.kind).toBe("acpx.acpSessionId");
          const calls = yield* f.calls();
          const created = calls.find((call) => call.method === "session/prompt");
          expect(rows[0]?.value).toBe(created?.sessionId);
          const files = yield* readdir(join(f.dir, "store", "sessions"));
          const key = files.find((file) => file.endsWith(".json"))?.slice(0, -5);
          if (key === undefined) {
            throw new Error("missing standard record");
          }
          const record = yield* until(store.load(decodeURIComponent(key)));
          if (record === undefined) {
            throw new Error("missing retained conversation");
          }
          expect(record.agentSessionId).toBe(undefined);
          if (differentKind) {
            record.agentSessionId = record.acpSessionId;
            yield* until(store.save(record));
          }
          held = false;
          const second = yield* attach(root, database, source, options);
          if (differentKind) {
            expect(second.failure).toBeDefined();
            expect(
              (yield* f.calls())
                .slice(calls.length)
                .filter((call) => call.method.startsWith("session/")),
            ).toEqual([]);
          } else {
            expect(second.failure).toBe(undefined);
            const delta = (yield* f.calls())
              .slice(calls.length)
              .filter((call) =>
                ["session/new", "session/load", "session/prompt"].includes(call.method),
              );
            expect(delta.map((call) => call.method)).toEqual(["session/load", "session/prompt"]);
            expect(delta.every((call) => call.sessionId === rows[0]?.value)).toBe(true);
            expect(JSON.stringify(second.output)).toContain("workflow-marker");
          }
          expect(mappingRows(workflowRunPath(root, database.record.runId))).toEqual(rows);
        });
      });
    });
  }
});

describe("fresh Codex preflight in the REPL", () => {
  it("fresh Codex preflight in the REPL", function* () {
    const root = yield* useStorageRoot();
    yield* createEmbeddedAdapters(join(root, "adapters")).materialize("codex");
    const bin = join(root, "bin");
    const home = join(root, "home");
    yield* ensureDir(bin);
    yield* ensureDir(home);
    const fake = (yield* readTextFile(
      fileURLToPath(new URL("../../acp/tests/fixtures/fake-codex-app-server.cjs", import.meta.url)),
    )).replace(/^#!.*\n/, "");
    const host = join(bin, "codex");
    yield* writeTextFile(
      host,
      [
        "#!/usr/bin/env node",
        'if (process.argv.includes("--version")) { console.log("codex-cli 0.153.2"); process.exit(0); }',
        `process.env.FAKE_CODEX_LOG = ${JSON.stringify(join(root, "app-server.jsonl"))};`,
        'process.env.FAKE_CODEX_AUTH_MARKER = "fixture-auth";',
        'process.env.FAKE_CODEX_CATALOG = "sol";',
        `process.env.FAKE_CODEX_ROLE_REPLY = require("node:fs").readFileSync(${JSON.stringify(join(root, "role-reply.json"))}, "utf8");`,
        fake,
      ].join("\n"),
    );
    yield* until(chmod(host, 0o755));
    const result = yield* scoped(function* () {
      yield* useQuietProcessOutput();
      return yield* exec({
        command: [
          process.execPath,
          "run",
          "--allow-all",
          "--node-modules-dir=manual",
          "--cached-only",
          "--frozen",
          fileURLToPath(new URL("./fixtures/fresh-codex-repl.ts", import.meta.url)),
          root,
        ],
        env: { HOME: home, PATH: bin + ":" + process.env.PATH, CODEX_PATH: "" },
      });
    });
    expect({ code: result.exitCode, output: result.stdout + result.stderr }).toMatchObject({
      code: 0,
    });
  });
});
