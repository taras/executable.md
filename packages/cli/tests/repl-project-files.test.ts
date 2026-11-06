import { runGit } from "./support/fixture-git.ts";
import { BUNDLED_PLUGIN } from "../src/run-profile.ts";
import { z } from "zod";
import { readGuideChapter } from "../src/repl/sidekick/guide.ts";
import { useDenoRepositoryOperations } from "@executablemd/git/deno";
import { InMemoryStream } from "@executablemd/durable-streams";
import { collect, inlineSource, registerComponents } from "@executablemd/core";
import { executeInstalled } from "@executablemd/core/host";
import { replRepositoryInstallation } from "../src/repl/repositories/deno/provider.ts";
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensureDir, readTextFile, writeTextFile, exists } from "@effectionx/fs";
import {
  API,
  cwd,
  Permissions,
  useHostFiles,
  captureHostFilesAccess,
  parseFileWriteFailure,
  parseFilesFailure,
} from "@executablemd/runtime";
import { scoped, until } from "effection";
import { readdir, symlink } from "node:fs/promises";
import { join, relative } from "node:path";
import { useTemporary } from "./fixtures/repl/issue-883/sidekick-harness.ts";
import { useMountedHost, mountedExecution, awaited, awaitedFact } from "./support/mounted-repl.ts";
import { useReplPage } from "./support/repl-page.ts";
import {
  sendMessage,
  saidBySidekick,
  sidekickIdle,
  pasteDraft,
  entrySettles,
} from "./support/screen-journeys.ts";
import { settledReading } from "./support/mounted-history.ts";
import { pairedLocation } from "../src/repl/sidekick/history.ts";

function submit(source: string): string {
  return `<Let as="code" value={${JSON.stringify(source)}} /><REPL.EntryInput>{code}</REPL.EntryInput><REPL.Submit />`;
}

describe("1113: project files through the mounted Sidekick", () => {
  it("1113: submitted work starts in P, scopes session source and assets, and restores sibling cwd", function* () {
    const project = yield* useTemporary("1113-project-");
    const host = yield* useMountedHost({ projectCwd: project, hostFiles: true });
    const page = yield* useReplPage({ host });
    const id = yield* mountedExecution(page.repl);
    const session = pairedLocation(host.root, id).directory;
    yield* ensureDir(join(session, "assets"));
    yield* ensureDir(join(project, "assets"));
    yield* writeTextFile(join(session, "assets/mock.html"), "session asset");
    yield* writeTextFile(join(project, "assets/mock.html"), "project asset");
    page.repl.fake.script({
      reply: submit(
        "<Output>" +
          [
            "<Cwd />",
            '<Dir path="nested"><File path="note">nested</File><File path="note" /><Glob include={["*"]} as="paths" /><Json value={paths} /><File.Delete path="note" /></Dir>',
            '<TempDir as="temporary"><File path="note">temporary</File><Cwd /></TempDir>',
            '<Let as="definition" value={"Hello <Cwd />"} /><REPL.ComponentDir><File path="Greeting.md">{definition}</File></REPL.ComponentDir>',
            '<REPL.AssetDir as="asset"><Cwd /><File path="mock.html" /><Glob include={["*.html"]} as="paths" /><Json value={paths} /></REPL.AssetDir>',
            '{asset}<File path="assets/mock.html" /><Cwd />',
          ].join("\n") +
          "</Output>",
      ),
    });
    page.repl.fake.script({ reply: "<REPL.Entry.Output entry={1} />" });
    page.repl.fake.script({
      reply: submit('<Greeting /><File path="ordinary">project work</File>'),
    });
    page.repl.fake.script({ reply: "<REPL.Entry.Output entry={2} />" });
    page.repl.fake.script({ reply: "<Output>1113 files done</Output>" });
    yield* sendMessage(page, "write and inspect project files");
    yield* page.until("project work", (reading) => saidBySidekick(reading, "1113 files done"));
    const read = yield* settledReading(page.repl);
    expect(read.model.entries.map((entry) => entry.terminal)).toMatchObject([
      { status: "ok" },
      { status: "ok" },
    ]);
    const output = read.model.entries[0]?.terminal?.output ?? "";
    expect(output).toContain(project);
    expect(output).toContain(join(session, "assets"));
    expect(output).toContain("session asset");
    expect(output).toContain("project asset");
    expect(output).toContain('"mock.html"');
    expect(output).toContain('"note"');
    expect(yield* exists(join(project, "nested/note"))).toBe(false);
    expect(yield* readTextFile(join(session, "components/Greeting.md"))).toBe("Hello <Cwd />");
    expect(yield* exists(join(project, "components/Greeting.md"))).toBe(false);
    expect(read.model.entries[1]?.terminal?.output).toBe(`Hello ${project}`);
    expect(yield* readTextFile(join(project, "ordinary"))).toBe("project work");
    expect(
      (yield* until(readdir(project))).filter((name) => name.startsWith("xmd-tempdir-")),
    ).toEqual([]);
    expect(yield* cwd()).toBe(project);
    expect(page.repl.fake.prompts.some((prompt) => prompt.includes("session asset"))).toBe(true);
    page.repl.terminal.end();
    yield* awaited("command exit", () => page.repl.outcome() !== undefined);
  });

  it("1113: private storage beneath P and transformed outside targets remain unavailable", function* () {
    const project = yield* useTemporary("1113-project-");
    const outside = yield* useTemporary("1113-outside-");
    yield* writeTextFile(join(outside, "canary"), "outside");
    const host = yield* useMountedHost({
      projectCwd: project,
      dataRoot: join(project, "storage"),
      hostFiles: true,
    });
    const page = yield* useReplPage({ host });
    const id = yield* mountedExecution(page.repl);
    const session = pairedLocation(host.root, id).directory;
    yield* writeTextFile(join(session, "private-canary"), "private");
    yield* until(symlink(outside, join(project, "outward"), "dir"));
    const sources = [
      '<File path="outward/canary" />',
      `<File path=${JSON.stringify(relative(project, join(session, "private-canary")))} />`,
      '<Glob include={["**/*"]} as="paths" /><Json value={paths} />',
      '<REPL.AssetDir><REPL.ComponentDir><File path="escape.md">wrong</File></REPL.ComponentDir></REPL.AssetDir>',
    ];
    for (const source of sources) {
      page.repl.fake.script({ reply: submit(source) });
    }
    page.repl.fake.script({ reply: "<Output>1113 refusals done</Output>" });
    yield* sendMessage(page, "try bounded file operations");
    yield* page.until("bounded refusal", (reading) =>
      saidBySidekick(reading, "1113 refusals done"),
    );
    const read = yield* settledReading(page.repl);
    expect(read.model.entries[0]?.terminal?.output).toContain("outside the working directory");
    expect(read.model.entries[1]?.terminal?.output).toContain("outside the working directory");
    expect(read.model.entries[2]?.terminal?.output).not.toContain("private-canary");
    expect(yield* exists(join(session, "components/escape.md"))).toBe(false);
    expect(yield* readTextFile(join(session, "private-canary"))).toBe("private");
    expect(yield* readTextFile(join(outside, "canary"))).toBe("outside");
    expect(yield* until(readdir(outside))).toEqual(["canary"]);
    page.repl.terminal.end();
    yield* awaited("command exit", () => page.repl.outcome() !== undefined);
  });
});

describe("1113: transformed Files requests", () => {
  for (const denied of [true, false]) {
    it(`1113: a transformed outside read refuses with read ${denied ? "denied" : "allowed"}`, function* () {
      const project = yield* useTemporary("1113-transformed-project-");
      const outside = yield* useTemporary("1113-transformed-outside-");
      const storage = yield* useTemporary("1113-transformed-storage-");
      yield* writeTextFile(join(outside, "note.md"), "outside canary");
      const access = yield* captureHostFilesAccess({
        project,
        private: storage,
        assets: join(storage, "session/assets"),
        components: join(storage, "session/components"),
      });
      const targetEvents: unknown[] = [];
      const outsideResolution: string[] = [];
      const outsideData: string[] = [];
      const inOutside = (path: string) => path === outside || path.startsWith(outside + "/");
      yield* API.Fs.around({
        *realpath([path], next) {
          if (inOutside(path)) {
            outsideResolution.push(path);
          }
          return yield* next(path);
        },
        *stat([path], next) {
          if (inOutside(path)) {
            outsideData.push(path);
          }
          return yield* next(path);
        },
        *readTextFile([path], next) {
          if (inOutside(path)) {
            outsideData.push(path);
          }
          return yield* next(path);
        },
        *readDirectory([path], next) {
          if (inOutside(path)) {
            outsideData.push(path);
          }
          return yield* next(path);
        },
      });
      yield* API.Env.around(
        {
          *cwd() {
            return project;
          },
        },
        { at: "min" },
      );
      yield* useHostFiles({ access, observe: (event) => targetEvents.push(event) });
      const recording = yield* replRepositoryInstallation("1113-transform", {
        projectCwd: project,
        access,
        operations: useDenoRepositoryOperations,
      });
      let refusal: string | undefined;
      const execution = yield* executeInstalled(
        { ...inlineSource('<File path="note.md" />'), includes: [], stream: new InMemoryStream() },
        [
          recording,
          {
            *install() {
              yield* API.Files.around({
                readTextFile: ([input], next) =>
                  scoped(function* () {
                    if (denied) {
                      yield* Permissions.around({
                        files: ([operation], onward) =>
                          operation === "read" ? false : onward(operation),
                      });
                    }
                    const result = yield* next({ ...input, cwd: outside });
                    refusal = result.ok
                      ? "unexpected success"
                      : parseFilesFailure(result.error)?.reason;
                    return result;
                  }),
              });
            },
          },
        ],
      );
      yield* collect(execution);
      expect(refusal).toBe(denied ? "permission-denied" : "resolved-escape");
      expect(targetEvents).toEqual([]);
      if (denied) {
        expect(outsideResolution).toEqual([]);
      }
      expect(outsideData).toEqual([]);
      expect(yield* readTextFile(join(outside, "note.md"))).toBe("outside canary");
      expect(yield* until(readdir(outside))).toEqual(["note.md"]);
    });
  }

  it("1113: a raw outside request refuses before ambient discovery", function* () {
    const project = yield* useTemporary("1113-raw-project-");
    const outside = yield* useTemporary("1113-raw-outside-");
    const storage = yield* useTemporary("1113-raw-storage-");
    const access = yield* captureHostFilesAccess({
      project,
      private: storage,
      assets: join(storage, "session/assets"),
      components: join(storage, "session/components"),
    });
    yield* writeTextFile(join(outside, "note.md"), "outside");
    yield* API.Env.around(
      {
        *cwd() {
          return outside;
        },
      },
      { at: "min" },
    );
    yield* useHostFiles({ access });
    let discovered = 0;
    const recording = yield* replRepositoryInstallation("1113-raw", {
      projectCwd: project,
      access,
      *operations() {
        const actual = yield* useDenoRepositoryOperations();
        return {
          ...actual,
          *ambientCheckout(directory) {
            discovered += 1;
            return yield* actual.ambientCheckout(directory);
          },
        };
      },
    });
    const execution = yield* executeInstalled(
      { ...inlineSource('<File path="note.md" />'), includes: [], stream: new InMemoryStream() },
      [recording],
    );
    expect(yield* collect(execution)).toContain("outside the working directory");
    expect(discovered).toBe(0);
    expect(yield* readTextFile(join(outside, "note.md"))).toBe("outside");
  });
});

describe("1113: executable capture teaching", () => {
  it("1113: runs the complete shipped passive-source response and reads the exact entry output", function* () {
    const project = yield* useTemporary("1113-capture-");
    const page = yield* useReplPage({ projectCwd: project, hostFiles: true });
    const chapter = yield* readGuideChapter("Entries");
    if (!chapter.ok) {
      throw chapter.error;
    }
    const teaching =
      chapter.value
        .split("### Capture command and component results")[1]
        ?.split("### Create and use")[0] ?? "";
    const response = teaching.match(/`````xmd\n([\s\S]*?)\n`````/)?.[1];
    expect(response).toBeDefined();
    page.repl.fake.script({ reply: response ?? "" });
    page.repl.fake.script({ reply: "<REPL.Entry.Output entry={1} offset={0} />" });
    page.repl.fake.script({ reply: "<Output>1113 capture done</Output>" });
    yield* sendMessage(page, "run the capture example");
    yield* page.until("capture output", (reading) => saidBySidekick(reading, "1113 capture done"));
    const read = yield* settledReading(page.repl);
    expect(read.model.entries[0]?.terminal?.status).toBe("ok");
    expect(JSON.parse(read.model.entries[0]?.terminal?.output ?? "null")).toEqual({
      exitCode: 7,
      stdout: "out",
      stderr: "err",
      componentOutput: "component text",
    });
    expect(page.repl.fake.prompts[1]).toContain("Entry entry-1 completed.");
    expect(page.repl.fake.prompts[2]).toContain("component text");
    expect(yield* readTextFile(join(project, "capture-demo.txt"))).toBe("component text");
    page.repl.terminal.end();
    yield* awaited("command exit", () => page.repl.outcome() !== undefined);
  });
});

describe("1113: session scopes retain their restrictions", () => {
  it("1113 M1: outer Content keeps AssetDir write denial after middleware redirects into P", function* () {
    const project = yield* useTemporary("1113-asset-redirect-project-");
    const redirects: {
      receivedCwd: string;
      effectiveCwd: string;
      effectivePath: string;
      writeAllowed: boolean;
      reason: string | undefined;
    }[] = [];
    const siblings: { writeAllowed: boolean; ok: boolean }[] = [];
    yield* API.Files.around({
      *writeTextFile([input], next) {
        if (input.path === "asset-canary") {
          const effective = { ...input, cwd: project, path: "project-canary" };
          const writeAllowed = yield* Permissions.operations.files("write");
          const result = yield* next(effective);
          redirects.push({
            receivedCwd: input.cwd,
            effectiveCwd: effective.cwd,
            effectivePath: effective.path,
            writeAllowed,
            reason: result.ok ? undefined : parseFileWriteFailure(result.error)?.reason,
          });
          return result;
        }
        if (input.path === "sibling-canary") {
          const writeAllowed = yield* Permissions.operations.files("write");
          const result = yield* next(input);
          siblings.push({ writeAllowed, ok: result.ok });
          return result;
        }
        return yield* next(input);
      },
    });
    const page = yield* useReplPage({ projectCwd: project, hostFiles: true });
    const session = pairedLocation(page.repl.root, yield* mountedExecution(page.repl)).directory;
    const assets = join(session, "assets");
    yield* ensureDir(assets);
    yield* writeTextFile(join(project, "project-canary"), "project bytes");
    yield* writeTextFile(join(project, "sibling-canary"), "before sibling");
    yield* writeTextFile(join(assets, "asset-canary"), "asset bytes");
    yield* writeTextFile(
      join(session, "components/ReadAssets.md"),
      "<REPL.AssetDir><Content /></REPL.AssetDir>",
    );
    const projectInventory = (yield* until(readdir(project))).sort();
    const assetInventory = (yield* until(readdir(assets))).sort();
    yield* pasteDraft(
      page,
      '<ReadAssets><File path="asset-canary">wrong</File></ReadAssets><File path="sibling-canary">allowed</File>',
    );
    yield* page.key("Enter");
    yield* awaitedFact("manual redirected write entry settles", function* () {
      return (yield* settledReading(page.repl)).model.entries[0]?.settled === true;
    });
    expect(redirects).toEqual([
      {
        receivedCwd: assets,
        effectiveCwd: project,
        effectivePath: "project-canary",
        writeAllowed: false,
        reason: "permission-denied",
      },
    ]);
    expect(siblings).toEqual([{ writeAllowed: true, ok: true }]);
    expect(yield* readTextFile(join(project, "project-canary"))).toBe("project bytes");
    expect(yield* readTextFile(join(assets, "asset-canary"))).toBe("asset bytes");
    expect(yield* readTextFile(join(project, "sibling-canary"))).toBe("allowed");
    expect((yield* until(readdir(project))).sort()).toEqual(projectInventory);
    expect((yield* until(readdir(assets))).sort()).toEqual(assetInventory);
    expect((yield* settledReading(page.repl)).model.entries[0]?.terminal?.output).toContain(
      "permission denied",
    );
    page.repl.terminal.end();
    yield* awaited("command exit", () => page.repl.outcome() !== undefined);
  });

  it("1113: entering absent assets does not allocate and projected content cannot write through it", function* () {
    const project = yield* useTemporary("1113-read-only-project-");
    const page = yield* useReplPage({ projectCwd: project, hostFiles: true });
    const session = pairedLocation(page.repl.root, yield* mountedExecution(page.repl)).directory;
    expect(yield* exists(join(session, "assets"))).toBe(false);
    page.repl.fake.script({
      reply: submit('<REPL.AssetDir><File path="missing" /></REPL.AssetDir>'),
    });
    page.repl.fake.script({ reply: "<Output>1113 absent assets inspected</Output>" });
    yield* sendMessage(page, "read absent session assets");
    yield* page.until("absent asset result", (reading) =>
      saidBySidekick(reading, "1113 absent assets inspected"),
    );
    expect(yield* exists(join(session, "assets"))).toBe(false);
    yield* ensureDir(join(session, "assets"));
    yield* writeTextFile(join(session, "assets/keep"), "keep");
    yield* writeTextFile(
      join(session, "components/ReadAssets.md"),
      "<REPL.AssetDir><Content /></REPL.AssetDir>",
    );
    const sources = [
      '<ReadAssets><File path="written">wrong</File></ReadAssets>',
      '<ReadAssets><File.Delete path="keep" /></ReadAssets>',
      '<ReadAssets><Dir path="."><File path="child">wrong</File></Dir></ReadAssets>',
      '<ReadAssets><TempDir><File path="temporary">wrong</File></TempDir></ReadAssets>',
      '<ReadAssets><REPL.ComponentDir><File path="Nested.md">wrong</File></REPL.ComponentDir></ReadAssets>',
    ];
    for (const source of sources) {
      page.repl.fake.script({ reply: submit(source) });
    }
    page.repl.fake.script({ reply: submit('<File path="sibling">allowed</File><Cwd />') });
    page.repl.fake.script({ reply: "<Output>1113 scopes done</Output>" });
    yield* sendMessage(page, "exercise the read-only projected scope");
    yield* page.until("read-only checks", (reading) => saidBySidekick(reading, "1113 scopes done"));
    expect(yield* readTextFile(join(session, "assets/keep"))).toBe("keep");
    expect(yield* until(readdir(join(session, "assets")))).toEqual(["keep"]);
    expect(yield* exists(join(session, "components/Nested.md"))).toBe(false);
    expect(
      (yield* until(readdir(project))).filter((name) => name.startsWith("xmd-tempdir-")),
    ).toEqual([]);
    expect(yield* readTextFile(join(project, "sibling"))).toBe("allowed");
    page.repl.terminal.end();
    yield* awaited("command exit", () => page.repl.outcome() !== undefined);
  });
});

describe("1113: receipt-directed exact output paging", () => {
  it("1113: follows the receipt's entry and each returned next argument until exact output is complete", function* () {
    const project = yield* useTemporary("1113-output-");
    const page = yield* useReplPage({ projectCwd: project, hostFiles: true });
    const expected = "LONG-" + "🙂abc".repeat(2500) + "-END";
    yield* writeTextFile(join(project, "long-output.txt"), expected);
    page.repl.fake.script({
      reply: submit('<File path="long-output.txt" as="long" /><Output>{long}</Output>'),
    });
    page.repl.fake.script({ reply: "<Output>1113 submission ready</Output>" });
    yield* sendMessage(page, "submit the long exact output");
    yield* page.until("the receipt", (reading) => saidBySidekick(reading, "1113 submission ready"));
    const receipt = page.repl.fake.prompts[1] ?? "";
    const initial = receipt.match(/<REPL.Entry.Output entry=\{(\d+)\} \/>/);
    expect(initial).not.toBeNull();
    const navigation = z.object({
      entry: z.number(),
      offset: z.number().optional(),
      limit: z.number().optional(),
    });
    const outputPage = z.object({ text: z.string(), next: navigation.nullable() });
    let next: z.infer<typeof navigation> | null =
      initial === null ? null : { entry: Number(initial[1]), offset: 0 };
    const parts: string[] = [];
    while (next !== null) {
      expect(parts.length).toBeLessThan(10);
      const before = page.repl.fake.prompts.length;
      page.repl.fake.script({
        reply: `<REPL.Entry.Output entry={${next.entry}}${next.offset === undefined ? "" : ` offset={${next.offset}}`}${next.limit === undefined ? "" : ` limit={${next.limit}}`} />`,
      });
      const done = `1113 output page ${parts.length}`;
      page.repl.fake.script({ reply: `<Output>${done}</Output>` });
      yield* sendMessage(page, "read the next exact page");
      // The persisted, attributed response rather than what the chat pane
      // happens to be showing: a long page fills the viewport, so the marker
      // being offscreen and the turn never completing look the same there.
      //
      // The screen's own rest is the cheap gate — this one message drives two
      // turns, and the next page may not be asked for until both have ended.
      // The history is then read once, where it says which turn answered: that
      // the evaluated response of this page's own exchange was retained
      // successfully, and that the control feedback carrying the page the case
      // parses below was retained beside it.
      // Both turns of this one message asked for, before rest is believed: the
      // screen is already at rest when the message is sent, so an idle gate on
      // its own would pass on the previous exchange's stillness. This counts
      // requests only to order the wait — what completion means is the
      // retained response read below, never a request having started.
      // deno-lint-ignore require-yield
      yield* awaitedFact(`page ${parts.length} asked for both turns`, function* () {
        return page.repl.fake.prompts.length >= before + 2;
      });
      yield* page.until(`page ${parts.length} exchange at rest`, (one) => sidekickIdle(one));
      // Read once, not polled: rest already says both turns of this exchange
      // ended, and this history holds a whole paged output — re-reading and
      // re-projecting it on a timer costs more than the observation is worth.
      // `settledReading` waits out an append still in flight by itself.
      const retained = yield* settledReading(page.repl);
      const answered = retained.chat.find(
        (one) => one.kind === "response" && one.hasOutput && one.output.includes(done),
      );
      if (answered === undefined || answered.kind !== "response") {
        throw new Error(
          `page ${parts.length} retained no completed response holding ${JSON.stringify(done)}. ` +
            `kinds=${JSON.stringify(retained.chat.map((one) => one.kind))}`,
        );
      }
      // Successful, and the control feedback that carried the page this case
      // parses below is retained on the same conversation.
      expect(answered.outcome.status).toBe("ok");
      expect(
        retained.chat.some(
          (one) =>
            one.kind === "feedback" &&
            one.conversation === answered.conversation &&
            one.text === page.repl.fake.prompts[before + 1],
        ),
      ).toBe(true);
      const read = outputPage.parse(JSON.parse(page.repl.fake.prompts[before + 1] ?? "null"));
      parts.push(read.text);
      next = read.next;
    }
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.join("")).toBe(expected);
    page.repl.terminal.end();
    yield* awaited("command exit", () => page.repl.outcome() !== undefined);
  });
});

describe("1113: project selection belongs to the actual entry", () => {
  it("1113: a fresh response and both entry origins observe P while storage is elsewhere", function* () {
    const project = yield* useTemporary("1113-owner-project-");
    const page = yield* useReplPage({ projectCwd: project, hostFiles: true });
    const session = pairedLocation(page.repl.root, yield* mountedExecution(page.repl)).directory;
    expect(session).not.toBe(project);
    yield* pasteDraft(page, "<Cwd />");
    yield* page.key("Enter");
    yield* entrySettles(page, 1, "ok");
    page.repl.fake.script({
      reply:
        '<Cwd as="directory" /><REPL.Environment as="environment" /><Output>{directory}|{environment}</Output>',
    });
    page.repl.fake.script({ reply: submit("<Cwd />") });
    page.repl.fake.script({ reply: "<REPL.Entry.Output entry={2} />" });
    page.repl.fake.script({ reply: "<Output>1113 owners done</Output>" });
    yield* sendMessage(page, "observe the response and submit another entry");
    yield* page.until("actual response cwd", (reading) =>
      saidBySidekick(reading, "1113 owners done"),
    );
    const read = yield* settledReading(page.repl);
    expect(read.model.entries.map((entry) => entry.terminal?.output)).toEqual([project, project]);
    expect(
      read.chat
        .filter((record) => record.kind === "response")
        .map((record) => record.output)
        .join("\n"),
    ).toContain(`${project}|`);
    expect(page.repl.fake.prompts[1]).toContain(`- working directory: ${project}`);
    page.repl.terminal.end();
    yield* awaited("command exit", () => page.repl.outcome() !== undefined);
  });

  it("1113: manual and Sidekick Git reads observe the same launch checkout", function* () {
    const project = yield* useTemporary("1113-git-project-");
    yield* runGit(project, ["init", "-b", "main"], { home: project });
    yield* writeTextFile(join(project, "seed.md"), "seed");
    yield* runGit(project, ["add", "seed.md"], { home: project });
    yield* runGit(project, ["commit", "-m", "seed"], { home: project });
    const managed = yield* useTemporary("1113-git-managed-");
    const observed: string[] = [];
    const host = yield* useMountedHost({
      projectCwd: project,
      hostFiles: true,
      plugins: [BUNDLED_PLUGIN],
      entryInstallation: (owner, placement) =>
        replRepositoryInstallation(owner, {
          ...placement,
          root: managed,
          *operations() {
            const actual = yield* useDenoRepositoryOperations();
            return {
              ...actual,
              *observe(element, request, place, verifier) {
                observed.push(place.root);
                return yield* actual.observe(element, request, place, verifier);
              },
            };
          },
        }),
    });
    const page = yield* useReplPage({ host });
    const source = '<Git.Files as="files" /><Output><Json value={files} /></Output>';
    yield* pasteDraft(page, source);
    yield* page.key("Enter");
    yield* entrySettles(page, 1, "ok");
    page.repl.fake.script({ reply: submit(source) });
    page.repl.fake.script({ reply: "<REPL.Entry.Output entry={2} />" });
    page.repl.fake.script({ reply: "<Output>1113 Git done</Output>" });
    yield* sendMessage(page, "read this checkout");
    yield* page.until("both Git reads", (reading) => saidBySidekick(reading, "1113 Git done"));
    const read = yield* settledReading(page.repl);
    expect(read.model.entries.map((entry) => entry.terminal?.status)).toEqual(["ok", "ok"]);
    expect(read.model.entries.map((entry) => JSON.parse(entry.terminal?.output ?? "null"))).toEqual(
      [
        { paths: ["seed.md"], next: null },
        { paths: ["seed.md"], next: null },
      ],
    );
    const canonical = yield* API.Fs.operations.realpath(project);
    expect(observed).toEqual([canonical, canonical]);
    page.repl.terminal.end();
    yield* awaited("command exit", () => page.repl.outcome() !== undefined);
  });

  it("1113: absolute opt-in cannot enter an outside directory or execute its child", function* () {
    const project = yield* useTemporary("1113-absolute-project-");
    const outside = yield* useTemporary("1113-absolute-outside-");
    yield* writeTextFile(join(outside, "canary"), "outside");
    yield* Permissions.around(
      { files: ([operation], next) => (operation === "absolute" ? true : next(operation)) },
      { at: "min" },
    );
    let children = 0;
    yield* registerComponents([
      {
        name: "ChildSentinel",
        origin: "test://1113",
        props: { type: "object", additionalProperties: false },
        *fn() {
          children += 1;
          return "entered";
        },
      },
    ]);
    const page = yield* useReplPage({ projectCwd: project, hostFiles: true });
    page.repl.fake.script({
      reply: submit(
        `<Dir path=${JSON.stringify(outside)}><ChildSentinel /><File path="canary">wrong</File></Dir>`,
      ),
    });
    page.repl.fake.script({ reply: "<Output>1113 outside refused</Output>" });
    yield* sendMessage(page, "try outside directory selection");
    yield* page.until("outside refusal", (reading) =>
      saidBySidekick(reading, "1113 outside refused"),
    );
    expect(children).toBe(0);
    expect(yield* readTextFile(join(outside, "canary"))).toBe("outside");
    expect(yield* until(readdir(outside))).toEqual(["canary"]);
    page.repl.terminal.end();
    yield* awaited("command exit", () => page.repl.outcome() !== undefined);
  });
});
