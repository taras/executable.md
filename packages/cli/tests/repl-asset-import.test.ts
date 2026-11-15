import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import {
  copyFile,
  link,
  mkdir,
  mkdtemp,
  realpath,
  readFile,
  writeFile,
  symlink,
  readdir,
  lstat,
  rm,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { allSettled, Ok, ensure, scoped, spawn, until, withResolvers, race } from "effection";
import type { Operation } from "effection";
import { Permissions } from "@executablemd/runtime/api";
import { FsApi } from "@effectionx/fs";
import { recoveredWork } from "../src/repl/sidekick/feedback.ts";
import { ReplHost } from "../src/repl/host.ts";
import { useNodeReplAssetImport } from "../src/node-repl-asset-import.ts";
import { records, useHarness, useTemporary } from "./fixtures/repl/issue-883/sidekick-harness.ts";
import type { Harness } from "./fixtures/repl/issue-883/sidekick-harness.ts";
import type { ReplElicitations, ReplQuestion } from "../src/repl/elicitation.ts";

const BINARY = new Uint8Array([0, 255, 128, 195, 40, 13, 10, 65]);

function nativeGate() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, resolve: () => release() };
}

function* question(questions: ReplElicitations): Operation<ReplQuestion> {
  const changes = yield* questions.changes;
  while (questions.pending === undefined) {
    yield* changes.next();
  }
  return questions.pending;
}

function invocation(source: string, destination: string): string {
  return `<REPL.ImportAsset source={${JSON.stringify(source)}} destination={${JSON.stringify(destination)}} />`;
}

function scripted(held: Harness, source: string, destination: string): void {
  held.fake.script({ reply: invocation(source, destination) });
  held.fake.script({ reply: "<Output>Finished.</Output>" });
}

function* instrument() {
  const io = { metadata: 0, reads: 0, writes: 0 };
  yield* FsApi.around({
    *stat([path], next) {
      io.metadata++;
      return yield* next(path);
    },
    *lstat([path], next) {
      io.metadata++;
      return yield* next(path);
    },
  });
  yield* useNodeReplAssetImport({
    realpath: (path) => {
      io.metadata++;
      return realpath(path);
    },
    mkdir: (path, options) => {
      io.writes++;
      return mkdir(path, options);
    },
    mkdtemp: (path) => {
      io.writes++;
      return mkdtemp(path);
    },
    copyFile: (source, target, mode) => {
      io.reads++;
      io.writes++;
      return copyFile(source, target, mode);
    },
    link: (source, target) => {
      io.writes++;
      return link(source, target);
    },
  });
  return io;
}

function* fixture(bytes: Uint8Array = BINARY) {
  const directory = yield* until(realpath(yield* useTemporary("xmd-asset-source-")));
  const source = join(directory, "mock ü name.bin");
  yield* until(writeFile(source, bytes));
  return { source, bytes };
}

function* importThroughOwner(bytes: Uint8Array, destination: string, deniedAbsolute = false) {
  const source = yield* fixture(bytes);
  const io = yield* instrument();
  const held = yield* useHarness();
  if (deniedAbsolute) {
    expect(
      (yield* hostFilesHandler().ensureDirectory({
        cwd: held.workspace,
        path: dirname(source.source),
      })).ok,
    ).toBe(false);
  }
  scripted(held, source.source, destination);
  const sending = yield* spawn(() => held.owner.message("Import this asset"));
  const asking = yield* question(held.owner.questions);
  expect(asking.message).toBe(
    `Source: ${source.source}\nDestination: ${join(yield* until(realpath(held.workspace)), destination)}\nWorkspace path after import: ${destination}\nImport copies this file into your session assets folder.`,
  );
  expect(asking.form.fields[0]?.choices).toEqual(["Import", "Decline"]);
  expect(io.reads).toBe(0);
  expect(io.writes).toBe(0);
  expect(asking.submit({}).kind).not.toBe("answered");
  expect(asking.submit({ decision: "invalid" }).kind).not.toBe("answered");
  expect(held.owner.questions.pending).toBe(asking);
  expect(asking.submit({ decision: "Import" }).kind).toBe("answered");
  const result = yield* sending;
  if (!result.ok) {
    throw result.error;
  }
  expect([...(yield* until(readFile(join(held.workspace, destination))))]).toEqual([...bytes]);
  expect([...(yield* until(readFile(source.source)))]).toEqual([...bytes]);
  const saved = yield* records(held.execution);
  const serialized = JSON.stringify(saved);
  expect(serialized).toContain("REPL.ImportAsset");
  expect(serialized).toContain(destination);
  expect(serialized).not.toContain(JSON.stringify([...bytes]));
  const imported = saved.find((one) => one.kind === "control-outcome" && one.order === 0);
  expect(imported?.kind === "control-outcome" ? imported.observed : undefined).toBe(destination);
  expect(io.reads).toBe(1);
  return { held, source: source.source, io };
}

describe("Sidekick image feedback", () => {
  it("reads an arbitrary imported binary asset with a caller-supplied size bound", function* () {
    yield* useNodeReplAssetImport();
    const held = yield* useHarness();
    const path = "reference/binary sample.bin";
    const target = join(held.workspace, "assets", path);
    yield* until(mkdir(dirname(target), { recursive: true }));
    yield* until(writeFile(target, BINARY));

    const [read, tooLarge, outside] = yield* allSettled([
      ReplHost.operations.readAsset(held.workspace, path, BINARY.length),
      ReplHost.operations.readAsset(held.workspace, path, BINARY.length - 1),
      ReplHost.operations.readAsset(held.workspace, "../binary sample.bin", BINARY.length),
    ]);
    expect(read.ok && [...read.value]).toEqual([...BINARY]);
    expect(!tooLarge.ok && tooLarge.error.message).toContain("at most");
    expect(!outside.ok && outside.error.message).toContain("relative to the session's assets");
  });

  it("refuses an asset redirected outside the session assets", function* () {
    yield* useNodeReplAssetImport();
    const held = yield* useHarness();
    const outside = yield* fixture(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
    const path = "reference/redirect.bin";
    const target = join(held.workspace, "assets", path);
    yield* until(mkdir(dirname(target), { recursive: true }));
    yield* until(symlink(outside.source, target));
    try {
      yield* ReplHost.operations.readAsset(held.workspace, path, 64);
    } catch (error) {
      expect(String(error)).toContain("stored under the session assets");
      return;
    }
    throw new Error("The native asset reader followed a symlink");
  });

  it("sends both images with their ordered provenance and retains only the provenance", function* () {
    const first = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
    const second = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 2]);
    const screenshots = new Map([
      ["reference/first image.png", first],
      ["reference/second image.png", second],
    ]);
    yield* useNodeReplAssetImport();
    const held = yield* useHarness();
    for (const [path, bytes] of screenshots) {
      const source = yield* fixture(bytes);
      scripted(held, source.source, `assets/${path}`);
      const sending = yield* spawn(() => held.owner.message("Import screenshot"));
      const approval = yield* question(held.owner.questions);
      expect(approval.submit({ decision: "Import" }).kind).toBe("answered");
      const imported = yield* sending;
      if (!imported.ok) {
        throw imported.error;
      }
    }
    const firstComparisonTurn = held.fake.turns.length;
    held.fake.script({
      reply: [...screenshots.keys()]
        .map((path) => `<REPL.InspectImage path="${path}" />`)
        .join("\n"),
    });
    held.fake.script({ reply: "<Output>Looked at the images.</Output>" });
    const result = yield* held.owner.message("Compare the screenshots");
    if (!result.ok) {
      throw result.error;
    }
    expect(held.fake.turns[firstComparisonTurn]?.attachments).toBeUndefined();
    expect(held.fake.turns[firstComparisonTurn + 1]?.attachments).toEqual(
      [...screenshots.values()].map((bytes) => ({
        mediaType: "image/png",
        data: bytes.toString("base64"),
      })),
    );
    const retained = yield* records(held.execution);
    const saved = JSON.stringify(retained);
    const imageControl = retained.find(
      (record) => record.kind === "control" && record.component === "REPL.InspectImage",
    );
    if (imageControl?.kind !== "control") {
      throw new Error("Expected a retained image control");
    }
    const reopened = yield* held.repository.open(held.execution.id);
    const recovered = recoveredWork(yield* records(reopened), imageControl);
    expect(recovered).toContain("Use REPL.InspectImage again to view them.");
    for (const [path, bytes] of screenshots) {
      const observation = `${path} (SHA-256 ${createHash("sha256").update(bytes).digest("hex")})`;
      expect(held.fake.turns[firstComparisonTurn + 1]?.text).toContain(observation);
      expect(saved).toContain(observation);
      expect(recovered).toContain(observation);
      expect(recovered).not.toContain(bytes.toString("base64"));
      expect(saved).not.toContain(bytes.toString("base64"));
    }
  });
});

describe("approved Sidekick asset import", () => {
  it("A2/A3: actual captured approval copies text and two independently known binary inputs", function* () {
    yield* scoped(() =>
      importThroughOwner(new TextEncoder().encode("mock text ü\n"), "assets/mock ü name.html"),
    );
    yield* scoped(() => importThroughOwner(BINARY, "assets/mock ü name.bin"));
    yield* scoped(() =>
      importThroughOwner(new Uint8Array([255, 0, 1, 194, 66]), "assets/changed.bin"),
    );
  });

  it("1075: ordinary absolute denial survives an approved import and a returned-relative read", function* () {
    yield* Permissions.around({
      files: ([operation], next) => (operation === "absolute" ? false : next(operation)),
    });
    yield* useHostFiles();
    yield* useNormalizedOutput();
    const { held, source } = yield* importThroughOwner(
      new TextEncoder().encode("copied text"),
      "assets/mock ü.html",
      true,
    );
    const direct = yield* hostFilesHandler().ensureDirectory({
      cwd: held.workspace,
      path: dirname(source),
    });
    expect(direct.ok).toBe(false);
    const read = yield* hostFilesHandler().readTextFile({
      cwd: held.workspace,
      path: "assets/mock ü.html",
    });
    expect(read).toEqual(Ok("copied text"));
    expect(
      (yield* hostFilesHandler().ensureDirectory({ cwd: held.workspace, path: dirname(source) }))
        .ok,
    ).toBe(false);
    expect(yield* Permissions.operations.files("absolute")).toBe(false);
  });

  it("A4: Decline and pending cancellation perform no content reads or writes", function* () {
    for (const decision of ["Decline", "Stop"]) {
      yield* scoped(function* () {
        const { source } = yield* fixture();
        const io = yield* instrument();
        const held = yield* useHarness();
        scripted(held, source, "assets/declined.bin");
        const sending = yield* spawn(() => held.owner.message("Import"));
        const asking = yield* question(held.owner.questions);
        if (decision === "Decline") {
          asking.submit({ decision });
          yield* sending;
        } else {
          yield* held.owner.stop();
          yield* sending;
        }
        expect(io.reads).toBe(0);
        expect(io.writes).toBe(0);
        expect(held.owner.questions.pending).toBeUndefined();
      });
    }
  });

  it("A5: effective denial precedes metadata, and changed policy is checked after approval", function* () {
    for (const kind of ["read", "write"]) {
      yield* scoped(function* () {
        const io = yield* instrument();
        yield* Permissions.around({
          files: ([operation], next) => (operation === kind ? false : next(operation)),
        });
        const result = yield* ReplHost.operations.importAsset({
          workspace: "/unread",
          source: "/unread/source",
          destination: "assets/input",
        });
        expect(result.ok).toBe(false);
        expect(io).toEqual({ metadata: 0, reads: 0, writes: 0 });
      });
    }
    const { source } = yield* fixture();
    const io = yield* instrument();
    let permit = true;
    yield* Permissions.around({ files: ([operation], next) => (permit ? next(operation) : false) });
    const held = yield* useHarness();
    scripted(held, source, "assets/policy.bin");
    const sending = yield* spawn(() => held.owner.message("Import"));
    const asking = yield* question(held.owner.questions);
    permit = false;
    asking.submit({ decision: "Import" });
    yield* sending;
    expect(io.reads).toBe(0);
    expect(io.writes).toBe(0);
  });

  it("A5/A6: containment and all occupied final kinds refuse without writes", function* () {
    const { source } = yield* fixture();
    const workspace = yield* useTemporary("xmd-asset-dest-");
    yield* until(mkdir(join(workspace, "assets")));
    yield* until(writeFile(join(workspace, "assets/file"), "KEEP"));
    yield* until(mkdir(join(workspace, "assets/directory")));
    yield* until(symlink("absent", join(workspace, "assets/dangling")));
    yield* until(symlink("/", join(workspace, "assets/outside")));
    const io = yield* instrument();
    for (const destination of [
      "assets/file",
      "assets/directory",
      "assets/dangling",
      "../escape",
      "/absolute",
      "assets/outside/tmp/escape",
    ]) {
      const result = yield* ReplHost.operations.importAsset({ workspace, source, destination });
      expect(result.ok).toBe(false);
    }
    expect(io.reads).toBe(0);
    expect(io.writes).toBe(0);
    expect((yield* until(lstat(join(workspace, "assets/dangling")))).isSymbolicLink()).toBe(true);
    expect(yield* until(readFile(join(workspace, "assets/file"), "utf8"))).toBe("KEEP");
  });

  it("A6: a late collision survives native no-replace publication", function* () {
    const { source } = yield* fixture();
    const held = yield* useHarness();
    yield* useNodeReplAssetImport({
      copyFile,
      mkdir,
      mkdtemp,
      realpath,
      link: (payload, destination) =>
        typeof destination === "string" && destination.endsWith("assets/late.bin")
          ? writeFile(destination, "LATE").then(() => link(payload, destination))
          : link(payload, destination),
    });
    scripted(held, source, "assets/late.bin");
    const sending = yield* spawn(() => held.owner.message("Import"));
    (yield* question(held.owner.questions)).submit({ decision: "Import" });
    yield* sending;
    expect(yield* until(readFile(join(held.workspace, "assets/late.bin"), "utf8"))).toBe("LATE");
    expect(
      (yield* until(readdir(join(held.workspace, "assets")))).filter((path) =>
        path.startsWith(".xmd-import-"),
      ),
    ).toEqual([]);
    scripted(held, source, "assets/chosen-new.bin");
    const retry = yield* spawn(() => held.owner.message("Choose this explicit new destination"));
    const fresh = yield* question(held.owner.questions);
    expect(fresh.message).toContain("Workspace path after import: assets/chosen-new.bin");
    fresh.submit({ decision: "Import" });
    yield* retry;
    expect([...(yield* until(readFile(join(held.workspace, "assets/chosen-new.bin"))))]).toEqual([
      ...BINARY,
    ]);
    expect(held.owner.questions.asked).toBe(2);
  });
});

import { useReplPage } from "./support/repl-page.ts";
import { mountedExecution, awaited } from "./support/mounted-repl.ts";
import { settledReading } from "./support/mounted-history.ts";
import {
  chooseOption,
  sendMessage,
  openQuestion,
  submitForm,
  stopSidekick,
  sidekickIdle,
  formOpen,
  pasteDraft,
} from "./support/screen-journeys.ts";

describe("mounted asset import", () => {
  it("A1/A2/A4: the form begins empty, closes unanswered, and approves the actual workspace", function* () {
    const { source, bytes } = yield* fixture(new TextEncoder().encode("mounted ü text"));
    const io = yield* instrument();
    const project = yield* useTemporary("1113-import-project-");
    yield* until(mkdir(join(project, "assets")));
    yield* until(writeFile(join(project, "assets/mock.html"), "independent project asset"));
    const page = yield* useReplPage({ projectCwd: project, hostFiles: true });
    const repl = page.repl;
    repl.fake.script({ reply: invocation(source, "assets/mock.html") });
    repl.fake.script({ reply: "<Output>Imported.</Output>" });
    yield* sendMessage(page, "Import this file");
    yield* page.until("the import question", (one) => one.shows("[answer sidekick]"));
    yield* openQuestion(page);
    expect(page.screen().shows("( ) Import")).toBe(true);
    expect(page.screen().shows("( ) Decline")).toBe(true);
    yield* submitForm(page);
    yield* page.until("untouched field refusal", (one) => one.shows("required"));
    expect(io.reads).toBe(0);
    expect(io.writes).toBe(0);
    yield* page.press("[close]", { after: "Answer" });
    yield* page.until(
      "closed unanswered form",
      (one) => !formOpen(one) && one.shows("[answer sidekick]"),
    );
    expect(io.reads).toBe(0);
    expect(io.writes).toBe(0);
    yield* openQuestion(page);
    yield* chooseOption(page, "Import");
    yield* submitForm(page);
    yield* page.until("joined import", (one) => one.shows("Imported.") && sidekickIdle(one));
    const execution = yield* mountedExecution(repl);
    const target = join(repl.root, "v1", execution, "assets/mock.html");
    expect([...(yield* until(readFile(target)))]).toEqual([...bytes]);
    const history = yield* settledReading(repl);
    expect(history.model.entries).toHaveLength(0);
    const intent = history.chat.find(
      (one) => one.kind === "control" && one.component === "REPL.ImportAsset",
    );
    expect(intent?.kind === "control" ? intent.arguments : undefined).toEqual({
      source,
      destination: "assets/mock.html",
    });
    const results = history.chat.filter((one) => one.kind === "control-outcome");
    expect(results.filter((one) => one.observed === "assets/mock.html")).toHaveLength(1);
    expect(
      results.filter((one) => JSON.stringify(one.observed) === '{"decision":"Import"}'),
    ).toHaveLength(1);
    const entry =
      '<REPL.AssetDir as="asset"><Cwd /><File path="mock.html" /><Glob include={["*.html"]} as="paths" /><Json value={paths} /></REPL.AssetDir><Output>{asset}|<File path="assets/mock.html" /></Output>';
    repl.fake.script({
      reply: `<Let as="code" value={${JSON.stringify(entry)}} /><REPL.EntryInput>{code}</REPL.EntryInput><REPL.Submit />`,
    });
    repl.fake.script({ reply: "<REPL.Entry.Output entry={1} />" });
    repl.fake.script({ reply: "<Output>1113 imported asset inspected</Output>" });
    yield* sendMessage(page, "inspect the approved asset in an entry");
    yield* page.until(
      "asset output",
      (one) => one.shows("1113 imported asset inspected") && sidekickIdle(one),
    );
    const inspected = yield* settledReading(repl);
    expect(inspected.model.entries[0]?.source).toBe(entry);
    expect(inspected.model.entries[0]?.terminal?.output).toContain("mounted ü text");
    expect(inspected.model.entries[0]?.terminal?.output).toContain('"mock.html"');
    expect(inspected.model.entries[0]?.terminal?.output).toContain("independent project asset");
    expect(inspected.model.entries[0]?.terminal?.output).toContain(
      join(repl.root, "v1", execution, "assets"),
    );
    expect(repl.fake.prompts.some((prompt) => prompt.includes("mounted ü text"))).toBe(true);
  });

  for (const origin of ["Stop", "Exit"]) {
    it(`A7: ${origin} joins a held actual native copy before staging removal`, function* () {
      const { source } = yield* fixture();
      const entered = withResolvers<void>();
      const gate = nativeGate();
      const joining = withResolvers<void>();
      const events: string[] = [];
      let temporary: string | undefined;
      yield* useNodeReplAssetImport({
        copyFile: (from, to, mode) => {
          entered.resolve();
          const transfer = gate.promise
            .then(() => copyFile(from, to, mode))
            .then(() => {
              events.push("copy complete");
            });
          const adopt = transfer.then.bind(transfer);
          transfer.then = (fulfilled, rejected) => {
            const retained = adopt(fulfilled, rejected);
            const then = retained.then.bind(retained);
            retained.then = (value, error) => {
              // The native owner's teardown joins both settlements of its retained request.
              if (value !== undefined && error !== undefined) {
                joining.resolve();
              }
              return then(value, error);
            };
            return retained;
          };
          return transfer;
        },
        link,
        mkdir,
        realpath,
        mkdtemp: (path) =>
          mkdtemp(path).then((made) => {
            temporary = made;
            return made;
          }),
      });
      yield* FsApi.around({
        *rm([path, options], next) {
          if (path === temporary) {
            events.push("cleanup");
          }
          return yield* next(path, options);
        },
      });
      const page = yield* useReplPage();
      const repl = page.repl;
      repl.fake.script({ reply: invocation(source, "assets/held.bin") });
      yield* sendMessage(page, "Import");
      yield* page.until("approval pending", (one) => one.shows("[answer sidekick]"));
      yield* openQuestion(page);
      yield* chooseOption(page, "Import");
      yield* submitForm(page);
      yield* entered.operation;
      expect(temporary).toBeDefined();
      yield* page.until("copying response", (one) => !formOpen(one) && one.shows("[stop]"));
      if (origin === "Stop") {
        yield* stopSidekick(page);
      } else {
        yield* page.press("[exit]");
      }
      yield* joining.operation;
      expect(repl.outcome()).toBeUndefined();
      expect(events).toEqual([]);
      expect(yield* until(readdir(temporary ?? ""))).toBeDefined();
      gate.resolve();
      if (origin === "Exit") {
        yield* awaited("Exit joined", () => repl.outcome() !== undefined);
      } else {
        yield* page.until("Stop joined", sidekickIdle);
      }
      expect(events).toEqual(["copy complete", "cleanup"]);
      expect(
        yield* until(
          lstat(temporary ?? "").then(
            () => false,
            () => true,
          ),
        ),
      ).toBe(true);
      const saved = yield* settledReading(repl);
      expect(
        saved.chat.filter(
          (one) => one.kind === "control-outcome" && one.observed === "assets/held.bin",
        ),
      ).toEqual([]);
    });
  }
});

describe("native import ownership and uncertain completion", () => {
  for (const phase of ["allocation", "publication"]) {
    it(`A7/A8: cancellation across held ${phase} joins and preserves the actual result`, function* () {
      const { source } = yield* fixture();
      const held = yield* useHarness();
      const entered = withResolvers<void>();
      const release = nativeGate();
      let temporary: string | undefined;
      const events: string[] = [];
      yield* useNodeReplAssetImport({
        copyFile,
        mkdir,
        realpath,
        mkdtemp: (path) =>
          phase === "allocation"
            ? mkdtemp(path).then((made) => {
                temporary = made;
                entered.resolve();
                return release.promise.then(() => made);
              })
            : mkdtemp(path).then((made) => {
                temporary = made;
                return made;
              }),
        link: (payload, final) =>
          phase === "publication"
            ? link(payload, final).then(() => {
                entered.resolve();
                return release.promise;
              })
            : link(payload, final),
      });
      yield* FsApi.around({
        *rm([path, options], next) {
          events.push("cleanup");
          return yield* next(path, options);
        },
      });
      scripted(held, source, "assets/cancelled.bin");
      const sending = yield* spawn(() => held.owner.message("Import"));
      (yield* question(held.owner.questions)).submit({ decision: "Import" });
      yield* entered.operation;
      const stopping = yield* spawn(() => held.owner.stop());
      expect(events).toEqual([]);
      release.resolve();
      yield* stopping;
      yield* sending;
      expect(events).toEqual(["cleanup"]);
      expect(
        yield* until(
          lstat(temporary ?? "").then(
            () => false,
            () => true,
          ),
        ),
      ).toBe(true);
      if (phase === "publication") {
        expect([...(yield* until(readFile(join(held.workspace, "assets/cancelled.bin"))))]).toEqual(
          [...BINARY],
        );
      } else {
        expect(
          yield* until(
            lstat(join(held.workspace, "assets/cancelled.bin")).then(
              () => false,
              () => true,
            ),
          ),
        ).toBe(true);
      }
      const saved = yield* records(held.execution);
      expect(JSON.stringify(saved)).not.toContain('"observed":"assets/cancelled.bin"');
    });
  }

  it("A7: an ordinary native copy rejection cleans its staged attempt", function* () {
    const { source } = yield* fixture();
    const held = yield* useHarness();
    yield* useNodeReplAssetImport({
      copyFile: () =>
        Promise.reject(Object.assign(new Error("COPY_REJECTED_1052"), { code: "EACCES" })),
      link,
      mkdir,
      mkdtemp,
      realpath,
    });
    scripted(held, source, "assets/failed.bin");
    const sending = yield* spawn(() => held.owner.message("Import"));
    (yield* question(held.owner.questions)).submit({ decision: "Import" });
    yield* sending;
    expect(
      (yield* until(readdir(join(held.workspace, "assets")))).filter((path) =>
        path.startsWith(".xmd-import-"),
      ),
    ).toEqual([]);
    expect(
      yield* until(
        lstat(join(held.workspace, "assets/failed.bin")).then(
          () => false,
          () => true,
        ),
      ),
    ).toBe(true);
  });

  it("A8: cleanup failure stops feedback after publication and leaves the import unfinished", function* () {
    const { source } = yield* fixture();
    const held = yield* useHarness();
    yield* useNodeReplAssetImport();
    let residue: string | undefined;
    yield* ensure(function* () {
      if (residue !== undefined) {
        yield* until(rm(residue, { recursive: true, force: true }));
      }
    });
    yield* FsApi.around({
      *rm([path, options], next) {
        if (typeof path === "string" && path.includes(".xmd-import-")) {
          residue = path;
          throw new Error("IMPORT_CLEANUP_FAILED_1052");
        }
        return yield* next(path, options);
      },
    });
    scripted(held, source, "assets/published.bin");
    const sending = yield* spawn(() => allSettled([scoped(() => held.owner.message("Import"))]));
    (yield* question(held.owner.questions)).submit({ decision: "Import" });
    const [result] = yield* sending;
    expect(result?.ok).toBe(false);
    expect(held.fake.prompts).toHaveLength(1);
    expect([...(yield* until(readFile(join(held.workspace, "assets/published.bin"))))]).toEqual([
      ...BINARY,
    ]);
    expect(JSON.stringify(yield* records(held.execution))).not.toContain(
      '"observed":"assets/published.bin"',
    );
  });
});

import { parseSidekickRecord } from "../src/repl/sidekick/history.ts";
import { projectSidekick } from "../src/repl/sidekick/model.ts";
import { API, hostFilesHandler, useHostFiles } from "@executablemd/runtime";
import { useNormalizedOutput } from "@executablemd/core";

describe("asset import acknowledgement and independent owners", () => {
  it("A8: a failed import outcome append supplies no success or passive retry", function* () {
    const { source } = yield* fixture();
    const held = yield* useHarness();
    const io = yield* instrument();
    yield* ReplHost.around({
      *appendRecord([path, line], next) {
        const record = parseSidekickRecord(line);
        if (record?.kind === "control-outcome" && record.order === 0) {
          throw new Error("IMPORT_OUTCOME_APPEND_FAILED_1052");
        }
        return yield* next(path, line);
      },
    });
    scripted(held, source, "assets/append.bin");
    const sending = yield* spawn(() => allSettled([scoped(() => held.owner.message("Import"))]));
    (yield* question(held.owner.questions)).submit({ decision: "Import" });
    const [result] = yield* sending;
    expect(result?.ok).toBe(false);
    expect(held.fake.prompts).toHaveLength(1);
    expect([...(yield* until(readFile(join(held.workspace, "assets/append.bin"))))]).toEqual([
      ...BINARY,
    ]);
    const before = { ...io };
    const cold = yield* held.repository.open(held.execution.id);
    if (cold.chat.form !== "paired") {
      throw new Error("The failed import lost its paired history.");
    }
    const read = projectSidekick(cold.chat.records);
    expect(read.ok).toBe(true);
    if (!read.ok) {
      throw read.error;
    }
    expect(read.value.unfinished.some((one) => one.component === "REPL.ImportAsset")).toBe(true);
    expect(io.reads).toBe(before.reads);
    expect(io.writes).toBe(before.writes);
    expect(held.owner.questions.asked).toBe(1);
  });

  it("A1: changed response cwd cannot move the actual workspace destination", function* () {
    const elsewhere = yield* useTemporary("xmd-asset-response-cwd-");
    yield* API.Env.around({
      *cwd() {
        return elsewhere;
      },
    });
    const { held } = yield* importThroughOwner(BINARY, "assets/root-wins.bin");
    expect(yield* until(readdir(elsewhere))).toEqual([]);
    expect([...(yield* until(readFile(join(held.workspace, "assets/root-wins.bin"))))]).toEqual([
      ...BINARY,
    ]);
  });

  it("A4: closing then stopping an import leaves an entry's independent question pending", function* () {
    const { source } = yield* fixture();
    const io = yield* instrument();
    const page = yield* useReplPage();
    yield* pasteDraft(
      page,
      '<Elicit schema={{type:"object",properties:{ok:{type:"string"}},required:["ok"],additionalProperties:false}} as="answer">The entry is asking.</Elicit>',
    );
    yield* page.key("Enter");
    yield* page.until("entry question", (one) => one.shows("[answer]"));
    page.repl.fake.script({ reply: invocation(source, "assets/never.bin") });
    yield* sendMessage(page, "Import");
    yield* page.until("import question", (one) => one.shows("[answer sidekick]"));
    yield* openQuestion(page);
    yield* page.press("[close]", { after: "Answer" });
    yield* page.until(
      "closed pending import",
      (one) => !formOpen(one) && one.shows("[answer sidekick]"),
    );
    yield* stopSidekick(page);
    yield* page.until(
      "joined unanswered import",
      (one) => sidekickIdle(one) && !one.shows("[answer sidekick]"),
    );
    expect(io.reads).toBe(0);
    expect(io.writes).toBe(0);
    yield* page.until("independent entry still asking", (one) => one.shows("[answer]"));
    const read = yield* settledReading(page.repl);
    expect(read.model.entries).toHaveLength(1);
    expect(read.model.entries[0]?.settled).toBe(false);
  });
});

describe("unavailable import owner", () => {
  it("A1: missing workspace refuses before reaching the native importer", function* () {
    const { source } = yield* fixture();
    const io = yield* instrument();
    const held = yield* useHarness(undefined, { workspace: false });
    const before = { ...io };
    scripted(held, source, "assets/missing.bin");
    const result = yield* held.owner.message("Import");
    expect(result.ok).toBe(true);
    expect(held.owner.questions.asked).toBe(0);
    expect(io.reads).toBe(before.reads);
    expect(io.writes).toBe(before.writes);
    expect(held.fake.prompts[1]).toContain("no session workspace");
  });
  it("A1: missing importer refuses with no host fallback", function* () {
    const result = yield* ReplHost.operations.importAsset({
      workspace: "/not-touched",
      source: "/not-touched/input",
      destination: "assets/file",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("no asset importer");
    }
  });
});

describe("1113: asset publication boundary", () => {
  it("1113 F1: a fresh non-assets request refuses through the actual owner without approval or staging", function* () {
    const { source } = yield* fixture();
    const io = yield* instrument();
    const held = yield* useHarness();
    const before = yield* until(readdir(held.workspace));
    for (const destination of [
      "inputs/new.bin",
      "components/new.bin",
      "root.bin",
      "assets/../private/new.bin",
    ]) {
      scripted(held, source, destination);
      const sending = yield* spawn(() => held.owner.message("Import outside assets"));
      const outcome = yield* race([
        (function* () {
          yield* sending;
          return "settled";
        })(),
        (function* () {
          yield* question(held.owner.questions);
          return "asked";
        })(),
      ]);
      if (outcome === "asked") {
        yield* held.owner.stop();
        yield* sending;
      }
      expect(outcome).toBe("settled");
      expect(held.owner.questions.asked).toBe(0);
      expect(held.fake.prompts.at(-1)).toContain("beneath this session's assets/");
    }
    expect(io.reads).toBe(0);
    expect(io.writes).toBe(0);
    expect(yield* until(readdir(held.workspace))).toEqual(before);
  });

  for (const kind of ["assets-root-sibling", "assets-root-outside", "assets-parent-outside"]) {
    it(`1113 F1: ${kind} refuses before approval and preserves outside bytes`, function* () {
      const { source } = yield* fixture();
      const io = yield* instrument();
      const held = yield* useHarness();
      const outside = yield* useTemporary("1113-import-outside-");
      yield* until(writeFile(join(outside, "canary"), BINARY));
      const sibling = join(held.workspace, "components");
      if (kind === "assets-parent-outside") {
        yield* until(mkdir(join(held.workspace, "assets")));
        yield* until(symlink(outside, join(held.workspace, "assets/nested")));
      } else {
        yield* until(
          symlink(
            kind === "assets-root-sibling" ? sibling : outside,
            join(held.workspace, "assets"),
          ),
        );
      }
      scripted(held, source, "assets/nested/new.bin");
      yield* held.owner.message("Import through a linked parent");
      expect(held.owner.questions.asked).toBe(0);
      expect(io.reads).toBe(0);
      expect(io.writes).toBe(0);
      expect(yield* until(readdir(outside))).toEqual(["canary"]);
      expect([...(yield* until(readFile(join(outside, "canary"))))]).toEqual([...BINARY]);
      expect(yield* until(readdir(sibling))).toEqual([]);
    });
  }

  it("1113 F1: rechecks the canonical destination after the staged copy before publication", function* () {
    const { source } = yield* fixture();
    const held = yield* useHarness();
    const outside = yield* useTemporary("1113-import-final-prefix-");
    const assets = join(yield* until(realpath(held.workspace)), "assets");
    let copied = false;
    let published = 0;
    yield* useNodeReplAssetImport({
      copyFile: (from, to, mode) =>
        copyFile(from, to, mode).then(() => {
          copied = true;
        }),
      mkdir,
      mkdtemp,
      realpath: (path) => (copied && path === assets ? Promise.resolve(outside) : realpath(path)),
      link: (from, to) => {
        published += 1;
        return link(from, to);
      },
    });
    scripted(held, source, "assets/final.bin");
    const sending = yield* spawn(() => held.owner.message("Import with a changed observed parent"));
    (yield* question(held.owner.questions)).submit({ decision: "Import" });
    yield* sending;
    expect(copied).toBe(true);
    expect(published).toBe(0);
    expect(yield* until(readdir(assets))).toEqual([]);
    expect(yield* until(readdir(outside))).toEqual([]);
    expect(held.fake.prompts.at(-1)).toContain("parent leaves this session's assets/");
  });

  it("1113 F1: an acknowledged historical inputs result remains passive and byte-identical", function* () {
    const destination = "inputs/old.bin";
    let fixtureImports = 0;
    // Build a historical acknowledgement fixture without issuing a new native import.
    yield* ReplHost.around({
      *importAsset() {
        fixtureImports += 1;
        return Ok(destination);
      },
    });
    const held = yield* useHarness();
    yield* until(mkdir(join(held.workspace, "inputs")));
    yield* until(writeFile(join(held.workspace, destination), BINARY));
    scripted(held, "/historical/source.bin", destination);
    yield* held.owner.message("Recorded historical import");
    expect(fixtureImports).toBe(1);
    if (held.execution.chat.form !== "paired") {
      throw new Error("Historical import needs paired storage");
    }
    const before = yield* until(readFile(held.execution.chat.location.sidekick, "utf8"));
    const io = yield* instrument();
    const cold = yield* held.repository.open(held.execution.id);
    if (cold.chat.form !== "paired") {
      throw new Error("Historical import lost its paired history");
    }
    expect(projectSidekick(cold.chat.records).ok).toBe(true);
    expect(yield* until(readFile(cold.chat.location.sidekick, "utf8"))).toBe(before);
    expect(
      cold.chat.records.some(
        (record) => record.kind === "control-outcome" && record.observed === destination,
      ),
    ).toBe(true);
    expect(io.reads).toBe(0);
    expect(io.writes).toBe(0);
    expect(fixtureImports).toBe(1);
    expect([...(yield* until(readFile(join(held.workspace, destination))))]).toEqual([...BINARY]);
    expect((yield* until(readdir(held.workspace))).includes("assets")).toBe(false);
  });
});
