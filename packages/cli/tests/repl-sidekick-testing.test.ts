import { DurablePersistenceError } from "@executablemd/durable-streams";
import { submitForSidekick } from "../src/repl/sidekick/admission.ts";
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { useComponentModuleLoader } from "@executablemd/test-support/host";
import { ensureDir, exists, readTextFile, rm, writeTextFile } from "@effectionx/fs";
import { allSettled, ensure, Ok, scoped, spawn, suspend, until, withResolvers } from "effection";
import type { Operation } from "effection";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { symlink } from "node:fs/promises";
import { z } from "zod";
import { SecretScannerError, registerComponents } from "@executablemd/core";
import { Execution } from "@executablemd/core/api";
import {
  Permissions,
  API,
  useHostFiles,
  FilesProviderUnavailableError,
} from "@executablemd/runtime";
import { readGuideChapter } from "../src/repl/sidekick/guide.ts";
import { pairedLocation } from "../src/repl/sidekick/history.ts";
import { testForSidekick, take } from "../src/repl/sidekick/admission.ts";
import { encodeLocation } from "../src/repl/route.ts";
import { initialState } from "../src/repl/application.ts";
import { useHarness, useTemporary } from "./fixtures/repl/issue-883/sidekick-harness.ts";
import {
  useMountedRepl,
  useMountedHost,
  mountedExecution,
  mountedReading,
  sendMessage,
  awaiting,
  shows,
  focusDraft,
  typing,
  click,
  screenOf,
} from "./fixtures/repl/issue-883/mounted-program.ts";
import type { MountedRepl } from "./fixtures/repl/issue-883/mounted-program.ts";

const reportSchema = z
  .object({
    path: z.string(),
    status: z.enum(["passed", "failed", "no-tests"]),
    documents: z.array(
      z
        .object({
          path: z.string(),
          status: z.enum(["passed", "failed", "no-tests"]),
          tests: z.array(
            z
              .object({
                status: z.enum(["pass", "fail"]),
                name: z.string().optional(),
                location: z.string(),
                error: z
                  .object({
                    kind: z.enum(["assertion", "timeout", "teardown", "error"]),
                    message: z.string(),
                    actual: z.string().optional(),
                    expected: z.string().optional(),
                  })
                  .strict()
                  .optional(),
              })
              .strict(),
          ),
          error: z.object({ name: z.string(), message: z.string() }).strict().nullable(),
          report: z.string(),
        })
        .strict(),
    ),
  })
  .strict();
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

function submit(source: string): string {
  return `<Let as="code" value={${JSON.stringify(source)}} />\n<REPL.EntryInput>{code}</REPL.EntryInput>\n<REPL.Submit />`;
}
function write(path: string, text: string): string {
  return `<Let as="file" value={${JSON.stringify(text)}} />\n<File path=${JSON.stringify(path)}>{file}</File>`;
}
function* mounted(
  includes?: readonly string[],
): Operation<{ repl: MountedRepl; workspace: string }> {
  yield* useComponentModuleLoader();
  const project = yield* useTemporary("xmd-testing-project-");
  const repl = yield* useMountedRepl({
    projectCwd: project,
    hostFiles: true,
    ...(includes === undefined ? {} : { includes }),
  });
  const workspace = pairedLocation(repl.root, yield* mountedExecution(repl)).directory;
  yield* writeTextFile(join(workspace, "package.json"), '{"type":"module"}');
  yield* until(symlink(join(ROOT, "node_modules"), join(workspace, "node_modules"), "dir"));
  return { repl, workspace };
}
let serial = 0;
function* exchange(repl: MountedRepl, replies: readonly string[]): Operation<void> {
  const done = `testing-finished-${serial++}`;
  for (const reply of replies) {
    repl.fake.script({ reply });
  }
  repl.fake.script({ reply: `<Output>${done}</Output>` });
  yield* sendMessage(repl, `run batch ${serial}`);
  yield* awaiting(repl.terminal, done, (terminal) => shows(terminal, done));
}
function* reports(repl: MountedRepl) {
  return (yield* mountedReading(repl)).chat.flatMap((record) =>
    record.kind === "control-outcome" &&
    record.observed !== undefined &&
    reportSchema.safeParse(record.observed).success
      ? [reportSchema.parse(record.observed)]
      : [],
  );
}
function passing(name = "real assertion", expected = "yes"): string {
  return `<Test name=${JSON.stringify(name)}><AssertEquals actual="yes" expected=${JSON.stringify(expected)} /></Test>`;
}

describe("REPL.Test accepted journeys", () => {
  it("R1: authors, fails, fixes and reuses ordinary Markdown without executing its creation", function* () {
    const { repl, workspace } = yield* mounted();
    const chapter = yield* readGuideChapter("Entries");
    if (!chapter.ok) {
      throw chapter.error;
    }
    const journey =
      chapter.value
        .split("### Test, fix and reuse a session component")[1]
        ?.split("## Common mistake")[0] ?? "";
    const examples = [...journey.matchAll(/````xmd\n([\s\S]*?)\n````/g)].map((match) => match[1]);
    expect(examples).toHaveLength(5);
    const [create, single, fail, fix, reuse] = examples;
    if (
      create === undefined ||
      single === undefined ||
      fail === undefined ||
      fix === undefined ||
      reuse === undefined
    ) {
      throw new Error("incomplete shipped testing examples");
    }
    const greeting =
      '<File path="greeting.txt">Hello from this session.</File>Hello from this session.';
    yield* exchange(repl, [create, "<REPL.Entry.Output entry={1} />"]);
    expect(yield* exists(join(workspace, "greeting.txt"))).toBe(false);
    expect(yield* reports(repl)).toEqual([]);
    expect((yield* mountedReading(repl)).model.entries).toHaveLength(1);
    expect(yield* readTextFile(join(workspace, "components/Greeting.md"))).toBe(greeting);
    yield* exchange(repl, [single]);
    expect((yield* reports(repl)).at(-1)?.status).toBe("passed");
    expect(yield* readTextFile(join(workspace, "greeting.txt"))).toBe("Hello from this session.");
    yield* exchange(repl, [fail]);
    const failed = (yield* reports(repl)).at(-1);
    expect(failed?.status).toBe("failed");
    expect(failed?.documents[0]?.tests[0]).toMatchObject({
      name: "greeting",
      status: "fail",
      error: { kind: "assertion", actual: '"Hello from this session."', expected: '"wrong"' },
    });
    expect(repl.fake.prompts.join("\n")).toContain("wrong");
    yield* exchange(repl, [fix, reuse]);
    expect((yield* reports(repl)).at(-1)?.status).toBe("passed");
    yield* focusDraft(repl.terminal);
    yield* typing(repl.terminal, "<Greeting />");
    repl.terminal.feed("\r");
    yield* awaiting(
      repl.terminal,
      "manual reuse",
      () =>
        screenOf(repl.terminal).join("\n").includes("entry-5") &&
        screenOf(repl.terminal).join("\n").includes("[ok]"),
    );
    const read = yield* mountedReading(repl);
    expect(read.model.entries.slice(-2).map((entry) => entry.source)).toEqual([
      "<Greeting />",
      "<Greeting />",
    ]);
    expect(read.model.entries.slice(-2).map((entry) => entry.terminal?.output)).toEqual([
      "Hello from this session.",
      "Hello from this session.",
    ]);
  });

  it("R2: tests and entries use a same-path TypeScript edit while old source and output stay retained", function* () {
    const { repl, workspace } = yield* mounted();
    const test = (value: string) =>
      `<Test name="direct"><Direct as="actual" /><AssertEquals actual={actual} expected=${JSON.stringify(value)} /></Test>`;
    for (const version of ["first", "second"]) {
      yield* exchange(repl, [
        submit(
          write(
            "components/Direct.ts",
            `export default function*() { const value: string = ${JSON.stringify(version)}; return value; }`,
          ) +
            "\n" +
            write("components/Direct.test.md", test(version)),
        ),
        '<REPL.Test path="components/Direct.test.md" />',
        submit("<Direct />"),
      ]);
    }
    expect((yield* reports(repl)).map((report) => report.status)).toEqual(["passed", "passed"]);
    const read = yield* mountedReading(repl);
    expect(
      read.model.entries
        .filter((entry) => entry.source === "<Direct />")
        .map((entry) => entry.terminal?.output),
    ).toEqual(["first", "second"]);
    const journal = yield* readTextFile(pairedLocation(repl.root, read.execution).entries);
    expect(journal).toContain('const value: string = \\"first\\"');
    expect(journal).toContain('const value: string = \\"second\\"');
    expect(yield* readTextFile(join(workspace, "components/Direct.ts"))).toContain('"second"');
  });

  it("R3: reports real ordered results, empty selections, no-tests, parse/runtime failures and partial output", function* () {
    const { repl, workspace } = yield* mounted();
    yield* ensureDir(join(workspace, "empty"));
    yield* writeTextFile(join(workspace, "components/a.test.md"), passing("first fails", "wrong"));
    yield* writeTextFile(
      join(workspace, "components/b.test.md"),
      "<Test><AssertEquals actual={1} expected={1} /></Test>",
    );
    yield* exchange(repl, ['<REPL.Test path="components" />']);
    let suite = (yield* reports(repl)).at(-1);
    expect(suite?.status).toBe("failed");
    expect(suite?.documents.map((document) => document.path)).toEqual([
      "components/a.test.md",
      "components/b.test.md",
    ]);
    expect(suite?.documents.map((document) => document.tests.length)).toEqual([1, 1]);
    expect(suite?.documents[1]?.tests[0]?.name).toBeUndefined();
    expect(suite?.documents[1]?.tests[0]?.location).toContain("b.test.md");
    yield* writeTextFile(join(workspace, "components/a.test.md"), passing());
    yield* exchange(repl, ['<REPL.Test path="components" />']);
    expect((yield* reports(repl)).at(-1)?.status).toBe("passed");
    const scenarios: ReadonlyArray<readonly [string, string | undefined, string]> = [
      ["empty", undefined, "no-tests"],
      ["components/zero.md", "no tests here", "no-tests"],
      ["components/boundary.md", "<Testing></Testing>", "no-tests"],
      ["components/parse.md", "---\nprops: [unclosed\n---\n", "failed"],
      [
        "components/runtime.md",
        'earlier rendered text\n\n<Fail message="runtime failed" />',
        "failed",
      ],
      [
        "components/unexpected.md",
        '<Test name="unexpected"><Fail message="unexpected body" /></Test>',
        "failed",
      ],
    ];
    for (const [path, text, expected] of scenarios) {
      if (text !== undefined) {
        yield* writeTextFile(join(workspace, path), text);
      }
      yield* exchange(repl, [`<REPL.Test path=${JSON.stringify(path)} />`]);
      suite = (yield* reports(repl)).at(-1);
      expect({ path, status: suite?.status }).toEqual({ path, status: expected });
      expect(suite?.path).toBe(path);
      if (text === undefined) {
        expect(suite?.documents).toEqual([]);
        continue;
      }
      expect(suite?.documents[0]?.error).not.toBeNull();
      if (path.includes("zero") || path.includes("boundary")) {
        expect(suite?.documents[0]?.tests).toEqual([]);
        expect(suite?.documents[0]?.error?.message).toContain("no tests");
      }
      if (path.includes("runtime")) {
        expect(suite?.documents[0]?.report).toContain("earlier rendered text");
      }
      if (path.includes("unexpected")) {
        expect(suite?.documents[0]?.tests[0]?.error?.kind).toBe("error");
      }
    }
    yield* writeTextFile(join(workspace, "components/c.test.md"), "valid without Test");
    yield* exchange(repl, ['<REPL.Test path="components" />']);
    expect((yield* reports(repl)).at(-1)?.status).toBe("failed");
    expect((yield* reports(repl)).at(-1)?.documents.map((document) => document.status)).toEqual([
      "passed",
      "passed",
      "no-tests",
    ]);
    for (const path of ["", "/tmp/absolute", "../escape"]) {
      const before = (yield* reports(repl)).length;
      yield* exchange(repl, [`<REPL.Test path=${JSON.stringify(path)} />`]);
      expect(yield* reports(repl)).toHaveLength(before);
    }
    yield* writeTextFile(join(workspace, "literal#%.md"), passing());
    yield* exchange(repl, ['<REPL.Test path="literal#%.md" />']);
    expect((yield* reports(repl)).at(-1)?.documents[0]?.path).toBe("literal#%.md");
  });
});

describe("REPL.Test selection, display and isolation", () => {
  it("R4: preserves configured selection, immutable declarations, document isolation and explicit display", function* () {
    const configured = yield* useTemporary("xmd-testing-includes-");
    yield* writeTextFile(join(configured, "Greeting.md"), "configured greeting");
    yield* registerComponents([
      {
        name: "HostValue",
        props: { type: "object" },
        origin: "test://host-value",
        fn: function* () {
          return "host declaration";
        },
      },
    ]);
    const { repl, workspace } = yield* mounted([configured]);
    yield* writeTextFile(join(workspace, "components/Greeting.md"), "session greeting");
    yield* writeTextFile(
      join(workspace, "components/selection.test.md"),
      '<Test name="selection"><Greeting as="actual" /><AssertEquals actual={actual} expected="configured greeting" /><HostValue as="host" /><AssertEquals actual={host} expected="host declaration" /></Test>',
    );
    yield* exchange(repl, [
      '<REPL.Syntax names={["Greeting"]} />',
      submit('<Let as="rootOnly" value="entry value" /><Greeting />'),
      '<REPL.Test path="components/selection.test.md" />',
      '<REPL.Test path="components" as="tests" />',
    ]);
    expect(repl.fake.prompts.join("\n")).toContain(join(configured, "Greeting.md"));
    expect((yield* reports(repl)).map((report) => report.status)).toEqual(["passed", "passed"]);
    expect((yield* mountedReading(repl)).model.entries[0]?.terminal?.output).toBe(
      "configured greeting",
    );
    const chat = (yield* mountedReading(repl)).chat.filter((record) => record.kind === "response");
    expect(chat.slice(-3, -1).every((record) => !record.hasOutput && record.output === "")).toBe(
      true,
    );
    yield* exchange(repl, [
      '<REPL.Test path="components/selection.test.md" as="tests" /><Output><Json value={tests} /></Output>',
    ]);
    const withOutput = (yield* mountedReading(repl)).chat
      .filter((record) => record.kind === "response")
      .at(-2);
    expect(withOutput?.hasOutput).toBe(true);
    expect(reportSchema.parse(JSON.parse(withOutput?.output ?? "null"))).toEqual(
      (yield* reports(repl)).at(-1),
    );
    yield* writeTextFile(
      join(workspace, "components/Registrar.ts"),
      [
        'import { registerComponents } from "@executablemd/core";',
        'export default function*() { yield* registerComponents([{name:"DocumentPrivate", origin:"test://document",props:{type:"object"},fn:function*(){return "leaked";}}]); return ""; }',
      ].join("\n"),
    );
    yield* ensureDir(join(workspace, "isolated"));
    yield* writeTextFile(
      join(workspace, "isolated/a.test.md"),
      '<Registrar /><Let as="documentOnly" value="document value" /><Test name="host binding absent"><AssertEquals actual={typeof rootOnly} expected="undefined" /></Test>',
    );
    yield* writeTextFile(
      join(workspace, "isolated/b.test.md"),
      '<Test name="binding absent"><AssertEquals actual={typeof documentOnly} expected="undefined" /></Test><Test name="registration absent"><DocumentPrivate /></Test>',
    );
    yield* exchange(repl, ['<REPL.Test path="isolated" />']);
    const isolated = (yield* reports(repl)).at(-1);
    expect(isolated?.documents.map((document) => document.status)).toEqual(["passed", "failed"]);
    expect(isolated?.documents[1]?.tests.map((test) => test.status)).toEqual(["pass", "fail"]);
    expect(isolated?.documents[1]?.tests[1]?.error?.message).toContain(
      "Cannot resolve component: DocumentPrivate",
    );
    yield* exchange(repl, [
      submit("<Json value={typeof documentOnly} />"),
      submit("<DocumentPrivate />"),
    ]);
    const entries = (yield* mountedReading(repl)).model.entries;
    expect(entries.map((entry) => ({ source: entry.source, terminal: entry.terminal }))).toEqual([
      expect.objectContaining({ source: '<Let as="rootOnly" value="entry value" /><Greeting />' }),
      expect.objectContaining({ source: "<Json value={typeof documentOnly} />" }),
    ]);
    expect(entries.at(-1)?.terminal?.output).toContain("undefined");
    expect(entries).toHaveLength(2);
    expect(repl.fake.prompts.join("\n")).toContain("Cannot resolve component: DocumentPrivate");
    yield* writeTextFile(join(configured, "Broken.md"), "---\nprops: [unclosed\n---\n");
    yield* writeTextFile(join(workspace, "components/Broken.md"), "fallback must not run");
    yield* writeTextFile(
      join(workspace, "components/broken.test.md"),
      '<Test name="selected malformed"><Broken /></Test>',
    );
    yield* exchange(repl, ['<REPL.Test path="components/broken.test.md" as="tests" />']);
    expect((yield* reports(repl)).at(-1)?.status).toBe("failed");
    expect((yield* reports(repl)).at(-1)?.documents[0]?.report).not.toContain(
      "fallback must not run",
    );
    expect(
      (yield* mountedReading(repl)).chat.filter((record) => record.kind === "response").at(-2)
        ?.hasOutput,
    ).toBe(false);
    yield* writeTextFile(join(workspace, "protected.txt"), "canonical file");
    yield* writeTextFile(join(workspace, "components/File.md"), "unprotected spoof");
    yield* writeTextFile(
      join(workspace, "components/protected.test.md"),
      '<Test name="protected"><File path="protected.txt" as="actual" /><AssertEquals actual={actual} expected="canonical file" /></Test>',
    );
    yield* exchange(repl, ['<REPL.Test path="components/protected.test.md" />']);
    expect((yield* reports(repl)).at(-1)?.status).toBe("passed");
  });

  it("R1 refusal: a completed entry with a denied File never reports successful component availability", function* () {
    yield* Permissions.around({ files: ([operation]) => operation !== "write" });
    const { repl, workspace } = yield* mounted();
    yield* exchange(repl, [
      submit(write("components/Never.md", '<File path="never-ran.txt">ran</File>unavailable')),
      "<REPL.Entry.Output entry={1} />",
    ]);
    expect(yield* exists(join(workspace, "components/Never.md"))).toBe(false);
    expect(yield* exists(join(workspace, "never-ran.txt"))).toBe(false);
    expect(yield* reports(repl)).toEqual([]);
    expect(repl.fake.prompts.join("\n")).toContain("permission");
  });
});

function* holdModule(
  workspace: string,
  key: string,
  body: () => void,
  cleanup: () => Operation<void>,
): Operation<void> {
  Reflect.set(globalThis, key, { body, cleanup });
  yield* ensure(function* () {
    Reflect.deleteProperty(globalThis, key);
  });
  yield* writeTextFile(
    join(workspace, "components/Hold.ts"),
    [
      'import { ensure, suspend } from "effection";',
      `const state = Reflect.get(globalThis, ${JSON.stringify(key)});`,
      'export default function*() { yield* ensure(() => state.cleanup()); state.body(); yield* suspend(); return "unreachable"; }',
    ].join("\n"),
  );
  yield* writeTextFile(
    join(workspace, "components/hold.test.md"),
    '<Test name="held"><Hold /></Test>',
  );
}

describe("REPL.Test admission and joined lifetime", () => {
  it("R5: refuses both submitters and a second test throughout response cancellation and gated cleanup", function* () {
    yield* useHostFiles();
    yield* useComponentModuleLoader();
    const held = yield* useHarness();
    yield* writeTextFile(join(held.workspace, "package.json"), '{"type":"module"}');
    yield* until(symlink(join(ROOT, "node_modules"), join(held.workspace, "node_modules"), "dir"));
    const entered = withResolvers<void>();
    const cleaning = withResolvers<void>();
    const release = withResolvers<void>();
    yield* holdModule(held.workspace, `held-${held.workspace}`, entered.resolve, function* () {
      cleaning.resolve();
      yield* release.operation;
    });
    held.fake.script({
      reply:
        '<REPL.EntryInput>preserved draft</REPL.EntryInput><REPL.Test path="components/hold.test.md" />',
    });
    const responding = yield* spawn(() => held.owner.message("hold this test"));
    yield* entered.operation;
    const before = held.state();
    function facts() {
      return {
        live: true,
        revisions: held.state().revisions,
        takenOver: false,
        draft: held.state().draft,
      };
    }
    function* refusal(): Operation<void> {
      expect(take("person", facts(), { entry: "entry-1", ordinal: 0 }, held.admitting).ok).toBe(
        false,
      );
      const second = yield* testForSidekick("components", {
        held: held.admitting,
        session: held.session,
        testing: held.profile.testing,
      });
      expect(second.ok).toBe(false);
      const submitted = yield* submitForSidekick(
        { conversation: "conversation:1", response: "response:1" },
        {
          session: {
            admits: () => held.session.admits(),
            entries: () => Ok([]),
            submit: (source, starting) => held.session.submit(source, undefined, starting),
          },
          facts,
          held: held.admitting,
          writer: held.execution.stream,
          woke() {},
          journal: {
            *began() {
              throw new Error("refused submission wrote an intent");
            },
            *settled() {
              throw new Error("refused submission wrote an outcome");
            },
          },
        },
      );
      expect(submitted.ok).toBe(false);
      expect(held.state()).toBe(before);
      expect(held.session.model.entries).toHaveLength(0);
    }
    yield* refusal();
    let stopped = false;
    const stopping = yield* spawn(function* () {
      yield* held.owner.stop();
      stopped = true;
    });
    yield* cleaning.operation;
    expect(stopped).toBe(false);
    expect(held.admitting.testing).toBe(true);
    yield* refusal();
    release.resolve();
    yield* stopping;
    yield* allSettled([responding]);
    expect(held.admitting.testing).toBe(false);
    expect(held.state().draft).toBe("preserved draft");
    const read = yield* held.repository.open(held.execution.id);
    if (read.chat.form !== "paired") {
      throw new Error("missing paired chat");
    }
    expect(
      read.chat.records.filter(
        (record) =>
          record.kind === "control-outcome" && reportSchema.safeParse(record.observed).success,
      ),
    ).toEqual([]);
    yield* writeTextFile(join(held.workspace, "components/hold.test.md"), passing());
    held.fake.script({ reply: '<REPL.Test path="components/hold.test.md" />' });
    held.fake.script({ reply: "<Output>after cleanup</Output>" });
    const next = yield* held.owner.message("now run it");
    expect(next.ok).toBe(true);
  });

  it("R5: test admission refuses a real entry in preflight, executing, paused and tearing down; Stop preserves its owner", function* () {
    yield* useHostFiles();
    const reading = withResolvers<void>();
    const allowRead = withResolvers<void>();
    let gated = false;
    yield* API.Fs.around({
      *readTextFile([path], next) {
        if (String(path).endsWith("EntryGate.md") && !gated) {
          gated = true;
          reading.resolve();
          yield* allowRead.operation;
        }
        return yield* next(path);
      },
    });
    const entered = withResolvers<void>();
    const bodyRelease = withResolvers<void>();
    const cleaning = withResolvers<void>();
    const cleanupRelease = withResolvers<void>();
    yield* registerComponents([
      {
        name: "EntryHold",
        origin: "test://entry-hold",
        props: { type: "object" },
        *fn() {
          yield* ensure(function* () {
            cleaning.resolve();
            yield* cleanupRelease.operation;
          });
          entered.resolve();
          yield* bodyRelease.operation;
          return "entry survived Stop";
        },
      },
    ]);
    const held = yield* useHarness();
    yield* writeTextFile(join(held.workspace, "components/EntryGate.md"), "<EntryHold />");
    yield* writeTextFile(join(held.workspace, "components/pass.test.md"), passing());
    held.fake.script({ reply: submit("<EntryGate />") });
    const response = yield* spawn(() => held.owner.message("run the ordinary entry"));
    yield* reading.operation;
    expect(held.admitting.held).toBeDefined();
    const ask = () =>
      testForSidekick("components/pass.test.md", {
        held: held.admitting,
        session: held.session,
        testing: held.profile.testing,
      });
    expect((yield* ask()).ok).toBe(false);
    allowRead.resolve();
    yield* entered.operation;
    expect((yield* ask()).ok).toBe(false);
    const controller = held.session.controller;
    if (controller === undefined) {
      throw new Error("entry lost its controller");
    }
    controller.pause();
    expect((yield* ask()).ok).toBe(false);
    controller.resume();
    yield* held.owner.stop();
    expect(held.session.admits().ok).toBe(false);
    bodyRelease.resolve();
    yield* cleaning.operation;
    expect((yield* ask()).ok).toBe(false);
    cleanupRelease.resolve();
    yield* held.session.join();
    yield* allSettled([response]);
    expect(held.session.model.entries[0]?.terminal?.output).toBe("entry survived Stop");
    expect((yield* ask()).ok).toBe(true);
  });

  it("R5: Exit joins response cleanup and normal test timeout/teardown keep their real result kinds", function* () {
    const { repl, workspace } = yield* mounted();
    yield* writeTextFile(
      join(workspace, "components/Timeout.ts"),
      'import { suspend } from "effection"; export default function*() { yield* suspend(); }',
    );
    yield* writeTextFile(
      join(workspace, "components/kinds.test.md"),
      '<Test name="timeout" timeout="10ms"><Timeout /></Test>\n<Test name="teardown">\n```js persist eval\nyield* spawn(function* () { try { yield* suspend(); } finally { throw new Error("per-test teardown"); } });\n```\n</Test>\n<Test name="after"><AssertEquals actual={1} expected={1} /></Test>',
    );
    yield* exchange(repl, ['<REPL.Test path="components/kinds.test.md" />']);
    const tests = (yield* reports(repl)).at(-1)?.documents[0]?.tests;
    expect(tests?.map((test) => [test.status, test.error?.kind])).toEqual([
      ["fail", "timeout"],
      ["fail", "teardown"],
      ["pass", undefined],
    ]);
    const entered = withResolvers<void>();
    const cleaning = withResolvers<void>();
    const release = withResolvers<void>();
    yield* holdModule(workspace, `exit-${workspace}`, entered.resolve, function* () {
      cleaning.resolve();
      yield* release.operation;
    });
    repl.fake.script({ reply: '<REPL.Test path="components/hold.test.md" />' });
    yield* sendMessage(repl, "cancel on exit");
    yield* entered.operation;
    repl.terminal.end();
    yield* cleaning.operation;
    expect(repl.outcome()).toBeUndefined();
    release.resolve();
    yield* awaiting(repl.terminal, "exit joining test cleanup", () => repl.outcome() !== undefined);
    expect(yield* reports(repl)).toHaveLength(1);
  });
});

describe("REPL.Test retained and fatal outcomes", () => {
  it("R6: reopen inspection keeps completed reports inert and unmatched work unknown until a new explicit request", function* () {
    yield* useComponentModuleLoader();
    const host = yield* useMountedHost({
      projectCwd: yield* useTemporary("repl-testing-history-"),
      hostFiles: true,
    });
    let id = "";
    let workspace = "";
    let entriesBefore = "";
    let chatBefore = "";
    let bodies = 0;
    yield* scoped(function* () {
      const repl = yield* useMountedRepl({ host });
      id = yield* mountedExecution(repl);
      const location = pairedLocation(repl.root, id);
      workspace = location.directory;
      yield* writeTextFile(join(workspace, "package.json"), '{"type":"module"}');
      yield* until(symlink(join(ROOT, "node_modules"), join(workspace, "node_modules"), "dir"));
      yield* exchange(repl, [
        submit(
          write("components/Greeting.md", "historical greeting") +
            "\n" +
            write("components/pass.test.md", passing()),
        ),
        '<REPL.Test path="components/pass.test.md" />',
        submit("<Greeting />"),
      ]);
      const entered = withResolvers<void>();
      yield* holdModule(
        workspace,
        `history-${workspace}`,
        () => {
          bodies++;
          entered.resolve();
        },
        function* () {},
      );
      repl.fake.script({ reply: '<REPL.Test path="components/hold.test.md" />' });
      yield* sendMessage(repl, "start interrupted tests");
      yield* entered.operation;
      yield* click(repl.terminal, "[stop]");
      yield* awaiting(repl.terminal, "Stop joins", (terminal) => shows(terminal, "[send]"));
      expect(yield* reports(repl)).toHaveLength(1);
      repl.terminal.end();
      yield* awaiting(repl.terminal, "first close", () => repl.outcome() !== undefined);
      entriesBefore = yield* readTextFile(location.entries);
      chatBefore = yield* readTextFile(location.sidekick);
    });
    const prompts = host.fake.prompts.length;
    yield* rm(join(workspace, "components/Greeting.md"));
    yield* rm(join(workspace, "components/pass.test.md"));
    const location = pairedLocation(host.root, id);
    const reopened = yield* useMountedRepl({
      host,
      location: encodeLocation(initialState(id).route),
    });
    const reading = yield* mountedReading(reopened);
    expect(reading.model.entries.at(-1)?.terminal?.output).toBe("historical greeting");
    expect((yield* reports(reopened))[0]?.status).toBe("passed");
    expect(host.fake.prompts).toHaveLength(prompts);
    expect(bodies).toBe(1);
    expect(yield* readTextFile(location.entries)).toBe(entriesBefore);
    expect(yield* readTextFile(location.sidekick)).toBe(chatBefore);
    reopened.fake.script({ reply: "<Output>inspection only</Output>" });
    yield* sendMessage(reopened, "continue explicitly after interruption");
    yield* awaiting(reopened.terminal, "explicit recovery response", (terminal) =>
      shows(terminal, "inspection only"),
    );
    expect(host.fake.prompts[prompts]).toContain("what it did is not known");
    expect(bodies).toBe(1);
    yield* writeTextFile(join(workspace, "components/pass.test.md"), passing());
    yield* exchange(reopened, ['<REPL.Test path="components/pass.test.md" />']);
    expect(yield* reports(reopened)).toHaveLength(2);
  });

  for (const kind of ["persistence", "files", "disclosure", "cleanup"]) {
    it(`R6: ${kind} authority stops the suite without a completed report`, function* () {
      const failure =
        kind === "persistence"
          ? new DurablePersistenceError("yield", new Error("controlled backing failure"))
          : kind === "files"
            ? new FilesProviderUnavailableError()
            : kind === "disclosure"
              ? new SecretScannerError("report disclosure")
              : new Error("owning runner cleanup failed");
      let later = 0;
      yield* registerComponents([
        {
          name: "Later",
          props: { type: "object" },
          origin: "test://later",
          fn: function* () {
            later++;
            return "";
          },
        },
      ]);
      yield* Execution.around({
        *execute([request], next) {
          if (request.options.path.endsWith("a.test.md")) {
            if (kind === "cleanup") {
              yield* ensure(function* () {
                throw failure;
              });
            } else {
              request.addCompletionFailure(() => failure);
            }
          }
          yield* next(request);
        },
      });
      let checked = false;
      const [result] = yield* allSettled([
        scoped(function* () {
          const { repl, workspace } = yield* mounted();
          yield* ensure(function* () {
            expect(later).toBe(0);
            expect(yield* reports(repl)).toEqual([]);
            const read = yield* mountedReading(repl);
            const failures = read.chat.filter(
              (record) => record.kind === "control-outcome" && record.outcome.status === "err",
            );
            expect(failures.length).toBeGreaterThan(0);
            expect(JSON.stringify(failures)).toContain(failure.name);
            checked = true;
          });
          yield* writeTextFile(join(workspace, "components/a.test.md"), passing());
          yield* writeTextFile(join(workspace, "components/b.test.md"), "<Later />" + passing());
          repl.fake.script({ reply: '<REPL.Test path="components" />' });
          yield* sendMessage(repl, `fail ${kind}`);
          if (kind === "cleanup") {
            yield* awaiting(repl.terminal, "cleanup failure", (terminal) =>
              shows(terminal, "[send]"),
            );
          } else {
            yield* suspend();
          }
        }),
      ]);
      expect(checked).toBe(true);
      if (kind !== "cleanup") {
        expect(result?.ok).toBe(false);
        if (result !== undefined && !result.ok) {
          expect(result.error).toBe(failure);
        }
      }
    });
  }
});
