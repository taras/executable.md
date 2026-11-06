import { runGit } from "./support/fixture-git.ts";
import { BUNDLED_PLUGIN } from "../src/run-profile.ts";
import { z } from "zod";
import { readGuideChapter } from "../src/repl/sidekick/guide.ts";
import { useDenoRepositoryOperations } from "@executablemd/git/deno";
import { projectSidekick } from "../src/repl/sidekick/model.ts";
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
import { ensure, race, scoped, spawn, until, withResolvers } from "effection";
import { readdir, symlink } from "node:fs/promises";
import { join, relative } from "node:path";
import { useTemporary } from "./fixtures/repl/issue-883/sidekick-harness.ts";
import {
  appendGate,
  awaited,
  awaitedFact,
  mountedExecution,
  useMountedHost,
} from "./support/mounted-repl.ts";
import { useReplPage } from "./support/repl-page.ts";
import {
  sendMessage,
  saidBySidekick,
  sidekickIdle,
  pasteDraft,
  entrySettles,
  intoComposer,
  COMPOSER,
  COMPOSER_VALUE,
  SIDEKICK_PANE,
} from "./support/screen-journeys.ts";
import type { Operation } from "effection";
import type { ReplPage, ScreenReading } from "./support/repl-page.ts";
import { settledReading } from "./support/mounted-history.ts";
import { pairedLocation, SIDEKICK_FILE } from "../src/repl/sidekick/history.ts";

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

/**
 * Whether the committed tree holds focus on the Message field itself.
 *
 * Read from the decoration on the field's own heading, not from its value rows
 * and not from the `> ` cue. The cue is written from the view the frame was
 * built from and is a frame behind; the value rows are read rather than
 * reached, and the field above them owns the focus and the keyboard. The frame
 * draws its focused node's runs bold from `tree.focused()` after the reconcile,
 * and this field's style role carries no weight of its own, so bold on its
 * heading means the tree holds focus there and nothing else does.
 *
 * The decoration is read from the emulator, which is sound because a page hands
 * a predicate only its latest reading and the emulator holds exactly the cells
 * that write left.
 */
function composerFocused(page: ReplPage, one: ScreenReading): boolean {
  const screen = page.repl.terminal.screen;
  if (screen === undefined) {
    throw new Error("The terminal emulator is absent.");
  }
  if (one.occurrences(COMPOSER) !== 1) {
    return false;
  }
  const at = one.locate(COMPOSER);
  return screen.styleAt(at.column, at.row).attrs.includes(1);
}

/**
 * Send one instruction the way a person at a keyboard sends it.
 *
 * Its own text, confirmed in the composer's own value rows: the ordinary helper
 * confirms against the whole screen, and the pane echoes every message it has
 * sent, so a page whose instruction repeated an earlier one would be confirmed
 * by that earlier row before these keystrokes arrived.
 *
 * Then one Enter, from the field the committed frame says holds focus. Enter in
 * this field and the pane's own Send ask for the same submission through the
 * same gate, so what this gives up is not the submission but the coordinate
 * press that used to perform it: this loop's rail is still filling, so the
 * control's coordinates can belong to a frame the program has already replaced,
 * and such a press is dropped with no action and no trace. Send's presence is
 * still required before the key, because it is this pane's own statement that a
 * submission is offered at all — eligibility, not acceptance, which is why the
 * provider request below is what settles that the message went.
 */
function* sendInstruction(page: ReplPage, text: string): Operation<void> {
  yield* intoComposer(page);
  yield* page.type(text);
  yield* page.until(
    `the composer holding ${JSON.stringify(text)}`,
    (one) => one.found(text, COMPOSER_VALUE) === 1,
  );
  yield* page.until(
    "the Sidekick offering its own Send",
    (one) => one.found("[send]", SIDEKICK_PANE) === 1,
  );
  yield* page.until(
    "the Message field holding focus in the committed frame",
    (one) => one.found(text, COMPOSER_VALUE) === 1 && composerFocused(page, one),
  );
  // This instruction is still unsent, by the only thing that could say
  // otherwise: no request the provider has received carries it. So the request
  // that carries it after the key below is this message's own, rather than an
  // echo of an earlier page.
  expect(page.repl.fake.prompts.some((one) => one.includes(text))).toBe(false);
  expect(page.screen().found(text, COMPOSER_VALUE)).toBe(1);
  const before = page.repl.fake.prompts.length;
  yield* page.key("Enter");
  yield* awaitedFact(`the provider asked with ${JSON.stringify(text)}`, function* () {
    return (
      page.repl.fake.prompts.length > before &&
      (page.repl.fake.prompts[before] ?? "").includes(text)
    );
  });
}

/**
 * What this page's exchange had actually reached, when it did not finish.
 *
 * Emitted beside the original failure and never instead of it: the reading the
 * wait gave up on, which instruction and phase it was, what the provider was
 * asked after this page began, and one read of the retained records. The read
 * is one read, and its own refusal is reported as itself rather than replacing
 * the failure that brought us here.
 *
 * The provider inputs are summarised by length and opening rather than quoted
 * whole, because one of them is the paged output and quoting it would bury the
 * facts this exists to show. Whether each one carries the instruction is stated
 * exactly.
 */
function* reportPagingFailure(
  page: ReplPage,
  detail: { readonly phase: string; readonly instruction: string; readonly before: number },
  failure: unknown,
): Operation<void> {
  // Copied before anything here suspends. The command keeps running while the
  // history read below yields and waits out an append in flight, so another
  // request or another presentation can arrive first — and read afterwards, a
  // wait that timed out on one request would be reported beside two later ones
  // and a later screen, losing the one boundary this exists to distinguish.
  const atFailure = Object.freeze({
    reading: page.describe(),
    askedSince: Object.freeze(
      page.repl.fake.prompts.slice(detail.before).map((one) =>
        Object.freeze({
          length: one.length,
          opening: one.slice(0, 200),
          holdsInstruction: one.includes(detail.instruction),
        }),
      ),
    ),
  });
  let retained: unknown;
  try {
    const read = yield* settledReading(page.repl);
    retained = {
      messages: read.chat.flatMap((one) =>
        one.kind === "message"
          ? [{ id: one.id, conversation: one.conversation, turn: one.turn, text: one.text }]
          : [],
      ),
      responses: read.chat.flatMap((one) =>
        one.kind === "response"
          ? [
              {
                conversation: one.conversation,
                turn: one.turn,
                status: one.outcome.status,
                hasOutput: one.hasOutput,
                holdsInstruction: one.output.includes(detail.instruction),
              },
            ]
          : [],
      ),
      feedback: read.chat.flatMap((one) =>
        one.kind === "feedback"
          ? [
              {
                conversation: one.conversation,
                turn: one.turn,
                length: one.text.length,
                opening: one.text.slice(0, 160),
              },
            ]
          : [],
      ),
    };
  } catch (error) {
    retained = {
      unavailable: error instanceof Error ? error.message : String(error),
    };
  }
  console.log(
    JSON.stringify({
      pagingFailure: detail.phase,
      instruction: detail.instruction,
      error: failure instanceof Error ? failure.message : String(failure),
      atFailure,
      // Named for when it was obtained: afterwards, not with the snapshot
      // above, so it describes the history at the end of the read rather than
      // the state the failed wait saw.
      retainedAfterwards: retained,
    }),
  );
}

/**
 * SCRATCH DIAGNOSTIC (#1140) — the setup gate itself, extracted so one case can
 * run exactly these checks while the setup response's append is held.
 *
 * Nothing about them changed: the pane at rest through the existing idle
 * discipline, one read of the retained history, that reading's own evaluated
 * response with an ok outcome and the acknowledgement carrying the receipt
 * against its conversation and turn, and then the same snapshot through the
 * canonical projector. File-local, exported nowhere, and used by the case and
 * its continuation so what runs is the gate rather than a second hand-written
 * copy of it.
 */
function* settleSetupExchange(
  page: ReplPage,
  observe: (permits: boolean) => void,
): Operation<void> {
  // The hook sits on this real predicate's own evaluation and records the
  // verdict it returns. It changes no decision: the value observed is the value
  // returned.
  yield* page.until("the setup exchange at rest", (one) => {
  const permits = sidekickIdle(one);
  observe(permits);
  return permits;
  });
  const settled = yield* settledReading(page.repl);
  const prepared = settled.chat.find(
      (one) =>
        one.kind === "response" && one.hasOutput && one.output.includes("1113 submission ready"),
  );
  if (prepared === undefined || prepared.kind !== "response") {
      throw new Error(
        "the setup retained no evaluated response holding its own marker. " +
          `kinds=${JSON.stringify(settled.chat.map((one) => one.kind))}`,
      );
  }
  expect(prepared.outcome.status).toBe("ok");
  const receipt = page.repl.fake.prompts[1] ?? "";
  expect(
      settled.chat.some(
        (one) =>
          one.kind === "feedback" &&
          one.conversation === prepared.conversation &&
          one.turn === prepared.turn &&
          one.text === receipt,
      ),
  ).toBe(true);
  const canonical = projectSidekick(settled.chat);
  if (!canonical.ok) {
      throw canonical.error;
  }
  const held = canonical.value.conversations.find((one) => one.id === prepared.conversation);
  if (held === undefined) {
      throw new Error(
        "the setup's own conversation is absent from the canonical reading. " +
          `ids=${JSON.stringify(canonical.value.conversations.map((one) => one.id))}`,
      );
  }
  expect(held.completed).toContain(prepared.turn);
  expect(
      canonical.value.delivered.some(
        (one) => one.conversation === prepared.conversation && one.turn === prepared.turn,
      ),
  ).toBe(true);
  expect(
      canonical.value.unestablished.filter((one) => one.conversation === prepared.conversation),
  ).toEqual([]);
}

/**
 * SCRATCH DIAGNOSTIC (#1140) — the page-zero continuation, at its own boundary.
 *
 * Everything the case did after the gate, unchanged: the receipt-derived entry,
 * each returned next argument, the typed parsing, the finite count greater than
 * one and the exact full Unicode text. Separated so reaching it is an event the
 * control can observe rather than something inferred from a request count.
 */
function* readExactPages(page: ReplPage, expected: string): Operation<void> {
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
      const instruction = `read exact page ${parts.length}`;
      let phase = "submission";
      try {
        yield* sendInstruction(page, instruction);
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
        phase = "both turns asked for";
        // deno-lint-ignore require-yield
        yield* awaitedFact(`page ${parts.length} asked for both turns`, function* () {
          return page.repl.fake.prompts.length >= before + 2;
        });
        phase = "exchange at rest";
        yield* page.until(`page ${parts.length} exchange at rest`, (one) => sidekickIdle(one));
        // Read once, not polled: rest already says both turns of this exchange
        // ended, and this history holds a whole paged output — re-reading and
        // re-projecting it on a timer costs more than the observation is worth.
        // `settledReading` waits out an append still in flight by itself.
        phase = "retained response and feedback";
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
      } catch (failure) {
        // Beside the failure, never instead of it: what this page's exchange
        // had actually reached when the wait gave up.
        yield* reportPagingFailure(page, { phase, instruction, before }, failure);
        throw failure;
      }
  }
  expect(parts.length).toBeGreaterThan(1);
  expect(parts.join("")).toBe(expected);
}

describe("1113: receipt-directed exact output paging", () => {
  it("1113: follows the receipt's entry and each returned next argument until exact output is complete", function* () {
    const project = yield* useTemporary("1113-output-");
    // SCRATCH DIAGNOSTIC (#1140) — the host's own append seam, so this case can
    // stand inside the interval the setup gate is about. Nothing else about the
    // mounted command changes.
    const gate = appendGate();
    const page = yield* useReplPage({ projectCwd: project, hostFiles: true, gate });
    const expected = "LONG-" + "🙂abc".repeat(2500) + "-END";
    yield* writeTextFile(join(project, "long-output.txt"), expected);
    page.repl.fake.script({
      reply: submit('<File path="long-output.txt" as="long" /><Output>{long}</Output>'),
    });
    page.repl.fake.script({ reply: "<Output>1113 submission ready</Output>" });
    // Held before the message goes, so the record this holds is the setup
    // response and nothing behind it: `holdNext` takes the next append its
    // predicate accepts and lets every other one through. The predicate names
    // the chat file, the response record kind and this setup's own marker, so
    // the first turn's response is not it.
    const heldSetup = gate.holdNext(
      (path, record) =>
        path.endsWith(SIDEKICK_FILE) &&
        record.includes('"kind":"response"') &&
        record.includes("1113 submission ready"),
    );
    // Registered before any setup work is issued, so no exit path can leave the
    // owner waiting on a held append. Released exactly once wherever it is
    // reached first.
    let releases = 0;
    const releaseOnce = (): void => {
      if (releases === 0) {
        releases += 1;
        heldSetup.release();
      }
    };
    yield* ensure(releaseOnce);
    yield* sendMessage(page, "submit the long exact output");
    yield* page.until("the receipt", (reading) => saidBySidekick(reading, "1113 submission ready"));
    // The interval itself. The owner streams the evaluated root's Output through
    // its publisher and appends the response record afterwards, so with that
    // append held the marker is on the screen while the record the setup gate
    // requires does not exist.
    yield* heldSetup.started();
    expect(heldSetup.inFlight).toBe(true);
    // One bounded reading of the canonical side at this instant — not polling,
    // and not the gate's own read. The evaluated response is absent, which is
    // why the gate below cannot permit anything yet.
    const during = yield* settledReading(page.repl);
    expect(
      during.chat.some(
        (one) =>
          one.kind === "response" && one.hasOutput && one.output.includes("1113 submission ready"),
      ),
    ).toBe(false);
    const duringCanonical = projectSidekick(during.chat);
    if (!duringCanonical.ok) {
      throw duringCanonical.error;
    }
    console.log(
      `XMDFLAKE ${
        JSON.stringify({
          what: "setupHeld",
          asked: page.repl.fake.prompts.length,
          responses: during.chat.filter((one) => one.kind === "response").length,
          conversations: duringCanonical.value.conversations.map((one) => ({
            id: one.id,
            completed: one.completed,
          })),
          delivered: duringCanonical.value.delivered,
          unestablished: duringCanonical.value.unestablished,
        })
      }`,
    );
    // The real gate and the real page-zero continuation, running concurrently
    // with the hold rather than after it. This is what makes the control about
    // the gate: it is entered while the response append is held, so what it
    // decides there is the gate's own decision, and the continuation behind it
    // is reachable the moment that decision permits.
    let evaluations = 0;
    let refusedAt: number | undefined;
    let permittedAt: number | undefined;
    let reachedPages = 0;
    let outcome: { readonly settled: "returned" | "threw"; readonly error?: string } | undefined;
    const refused = withResolvers<void>();
    const finished = withResolvers<void>();
    const gateTask = yield* spawn(function* () {
      try {
        yield* settleSetupExchange(page, (permits) => {
          evaluations += 1;
          if (permits) {
            permittedAt = permittedAt ?? evaluations;
            return;
          }
          if (refusedAt === undefined) {
            refusedAt = evaluations;
            refused.resolve();
          }
        });
        reachedPages += 1;
        yield* readExactPages(page, expected);
        outcome = { settled: "returned" };
      } catch (error) {
        outcome = {
          settled: "threw",
          error: error instanceof Error ? error.message : String(error),
        };
      } finally {
        finished.resolve();
      }
    });
    // Joined on every exit, so a failing assertion below cannot leave this task
    // waiting on the held append.
    yield* ensure(function* () {
      yield* gateTask.halt();
    });
    // The two outcomes raced, and neither side destroys the other: both are
    // resolvers, so losing one is not cancelling the gate. No interval elapses
    // and nothing sleeps — what settles this is the gate's own evaluation or
    // the gate's own completion, whichever happens.
    yield* race([refused.operation, finished.operation]);
    if (refusedAt === undefined) {
      throw new Error(
        "the setup gate did not evaluate a non-permitting condition while its own " +
          `response append was held. evaluations=${evaluations} ` +
          `permittedAt=${String(permittedAt)} outcome=${JSON.stringify(outcome)}`,
      );
    }
    // It refused, it has not finished, and the continuation behind it has not
    // been entered. A gate that was deleted or bypassed would have settled or
    // reached the pages here instead; one whose acceptance were the streamed
    // marker would have permitted, because that marker is already true —
    // which is exactly the counterexample this asserts beside it.
    expect(outcome).toBe(undefined);
    expect(reachedPages).toBe(0);
    expect(page.repl.fake.prompts).toHaveLength(2);
    expect(page.repl.fake.prompts.some((one) => one.includes("read exact page 0"))).toBe(false);
    expect(saidBySidekick(page.screen(), "1113 submission ready")).toBe(true);
    console.log(
      `XMDFLAKE ${
        JSON.stringify({
          what: "setupGateHeld",
          evaluations,
          refusedAt,
          permittedAt: permittedAt ?? null,
          reachedPages,
          asked: page.repl.fake.prompts.length,
        })
      }`,
    );
    // Released exactly once, then the same task is joined: its own run carries
    // the raw and canonical snapshot and every original paging assertion.
    releaseOnce();
    yield* gateTask;
    if (outcome === undefined || outcome.settled !== "returned") {
      throw new Error(
        `the setup gate and its pages did not complete after one release. ${JSON.stringify(outcome)}`,
      );
    }
    expect(reachedPages).toBe(1);
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
