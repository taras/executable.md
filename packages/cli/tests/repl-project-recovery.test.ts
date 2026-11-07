import type { ReplPluginInstallation } from "../api.ts";
import type { Operation } from "effection";
import { workspaceMountInstallation } from "../src/repl/workspace-mount-installation.ts";
import { validateProjectPlacement } from "../src/repl/startup.ts";
import { ReplTerminal } from "../src/repl/terminal.ts";
import { serializeDurableEvent } from "@executablemd/durable-streams";
import { PLACEMENT } from "../src/repl/entry-placement.ts";
import { ReplEntryHost } from "../src/repl-entry-installation.ts";
import type { ReplEntryInstallation } from "../src/repl-entry-installation.ts";
import { runXmd } from "../src/cli.ts";
import { Elicitation } from "@executablemd/core";
import { Plugin } from "@executablemd/core/api";
import { unsupportedWorkflowHost } from "../src/workflow.ts";
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { readTextFile, writeTextFile, exists, rm, ensureDir } from "@effectionx/fs";
import { API, cwd, Permissions } from "@executablemd/runtime";
import { scoped, spawn, until, createContext, withResolvers, ensure, sleep } from "effection";
import { realpath, rename, symlink } from "node:fs/promises";
import { join } from "node:path";
import { prepareReplStartup, runReplProgram } from "../src/repl/program.ts";
import { parseEntryPlacement } from "../src/repl/entry-placement.ts";
import { projectRepl } from "../src/repl/model.ts";
import { pairedLocation } from "../src/repl/sidekick/history.ts";
import { initialState } from "../src/repl/application.ts";
import { encodeLocation } from "../src/repl/route.ts";
import { useTemporary } from "./fixtures/repl/issue-883/sidekick-harness.ts";
import {
  awaited,
  awaitedFact,
  mountedExecution,
  recordingTerminal,
  useMountedHost,
} from "./support/mounted-repl.ts";
import { useReplPage } from "./support/repl-page.ts";
import { pasteDraft, sendMessage } from "./support/screen-journeys.ts";

function columnOf(cells: readonly string[], label: string): number {
  const offset = cells.join("").indexOf(label);
  let text = 0;
  for (const [column, cell] of cells.entries()) {
    if (text === offset && cell.length > 0) {
      return column;
    }
    text += cell.length;
  }
  return -1;
}

function* saved(sidekick = false) {
  const project = yield* useTemporary("1113-original-");
  const entryHost: ReplEntryInstallation = function* (_owner, placement) {
    return workspaceMountInstallation(
      placement?.mounts ?? [],
      undefined,
      placement?.access,
      placement?.projectCwd,
    );
  };
  const host = yield* useMountedHost({
    projectCwd: project,
    hostFiles: true,
    entryInstallation: entryHost,
  });
  let id = "";
  let entries = "";
  let chat = "";
  yield* scoped(function* () {
    const waiting = withResolvers<void>();
    yield* Elicitation.around({
      *elicit([request], next) {
        if (request.message === "Wait here.") {
          waiting.resolve();
        }
        return yield* next(request);
      },
    });
    const page = yield* useReplPage({ host });
    id = yield* mountedExecution(page.repl);
    const source =
      '<File path="acknowledged">one write</File><Elicit schema={{type:"object",properties:{answer:{type:"string",enum:["continue"]}},required:["answer"],additionalProperties:false}} as="answer">Wait here.</Elicit><Cwd />';
    if (sidekick) {
      page.repl.fake.script({
        reply: `<Let as="code" value={${JSON.stringify(source)}} /><REPL.EntryInput>{code}</REPL.EntryInput><REPL.Submit />`,
      });
      yield* sendMessage(page, "start the held entry");
    } else {
      yield* pasteDraft(page, source);
      yield* page.key("Enter");
    }
    yield* waiting.operation;
    yield* awaitedFact("acknowledged write", () => exists(join(project, "acknowledged")));
    const location = pairedLocation(host.root, id);
    entries = yield* readTextFile(location.entries);
    chat = yield* readTextFile(location.sidekick);
  });
  // The copied prefix is what a process loss leaves, before graceful teardown.
  const files = pairedLocation(host.root, id);
  yield* writeTextFile(files.entries, entries);
  yield* writeTextFile(files.sidekick, chat);
  const location = encodeLocation(initialState(id).route);
  return { project, host, files, entries, chat, location, id, entryHost };
}

describe("1113: project placement before live recovery", () => {
  it("1113: records the strict pair and needs no answer at the original root or an alias", function* () {
    const held = yield* saved();
    const reopened = yield* held.host.repository.open(held.id);
    const model = projectRepl(yield* reopened.stream.readAll());
    expect(model.ok).toBe(true);
    if (!model.ok) {
      throw model.error;
    }
    expect(model.value.entries[0]?.placement).toEqual({
      projectDirectory: held.project,
      canonicalProjectRoot: yield* until(realpath(held.project)),
    });
    const same = yield* prepareReplStartup(held.location, held.host.root, false);
    expect(same.ok).toBe(true);
    const alias = join(yield* useTemporary("1113-alias-"), "project");
    yield* until(symlink(held.project, alias, "dir"));
    yield* scoped(function* () {
      yield* API.Env.around(
        {
          *cwd() {
            return alias;
          },
        },
        { at: "min" },
      );
      const read = yield* prepareReplStartup(held.location, held.host.root, false);
      expect(read.ok && read.value.projectCwd).toBe(held.project);
    });
    expect(yield* readTextFile(held.files.entries)).toBe(held.entries);
    expect(yield* readTextFile(held.files.sidekick)).toBe(held.chat);
  });

  it("1113: a different noninteractive launch refuses before any continuation or history append", function* () {
    const held = yield* saved();
    const other = yield* useTemporary("1113-other-");
    yield* API.Env.around(
      {
        *cwd() {
          return other;
        },
      },
      { at: "min" },
    );
    const before = held.host.fake.prompts.length;
    const result = yield* prepareReplStartup(held.location, held.host.root, false);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.message).toContain(held.project);
    expect(held.host.fake.prompts).toHaveLength(before);
    expect(yield* readTextFile(held.files.entries)).toBe(held.entries);
    expect(yield* readTextFile(held.files.sidekick)).toBe(held.chat);
    expect(yield* cwd()).toBe(other);
  });

  it("1113: declined and cancelled startup offers leave history untouched and join cleanup", function* () {
    const held = yield* saved();
    const other = yield* useTemporary("1113-other-");
    yield* API.Env.around(
      {
        *cwd() {
          return other;
        },
      },
      { at: "min" },
    );
    for (const exit of ["escape", "interrupt", "eof", "halt", "decline", "presentation"]) {
      yield* scoped(function* () {
        const screen = recordingTerminal();
        yield* screen.install();
        if (exit === "presentation") {
          screen.terminal.failNextPresent(new Error("startup presentation refused"));
        }
        let done = false;
        const opening = yield* spawn(function* () {
          try {
            return yield* prepareReplStartup(held.location, held.host.root);
          } finally {
            done = true;
          }
        });
        if (exit === "presentation") {
          expect((yield* opening).ok).toBe(false);
        } else {
          yield* awaited("the original directory offer", () => screen.terminal.drawn > 1 || done);
          expect(done).toBe(false);
          const text = screen.terminal.presented
            .map((bytes) => new TextDecoder().decode(bytes))
            .join("");
          expect(text).toContain(held.project);
          expect(text).toContain(other);
          if (exit === "halt") {
            yield* opening.halt();
          } else {
            if (exit === "escape") {
              screen.terminal.feed("\x1b");
            } else if (exit === "interrupt") {
              screen.terminal.feed("\x03");
            } else if (exit === "eof") {
              screen.terminal.end();
            } else {
              const rows = screen.terminal.screen?.rows() ?? [];
              const row = rows.findIndex((text) => text.includes("( ) Leave unfinished"));
              const column = columnOf(
                screen.terminal.screen?.cells()[row] ?? [],
                "Leave unfinished",
              );
              screen.terminal.feed(`\x1b[<0;${column + 1};${row + 1}M`);
            }
            expect((yield* opening).ok).toBe(false);
          }
        }
        expect(screen.terminal.readers).toBe(0);
        expect(screen.terminal.listeners).toBe(0);
      });
      expect(yield* readTextFile(held.files.entries)).toBe(held.entries);
      expect(yield* readTextFile(held.files.sidekick)).toBe(held.chat);
    }
  });

  it("1113: startup waits for held screen cleanup before returning", function* () {
    const held = yield* saved();
    const other = yield* useTemporary("1113-other-");
    yield* API.Env.around(
      {
        *cwd() {
          return other;
        },
      },
      { at: "min" },
    );
    const terminal = recordingTerminal();
    yield* terminal.install();
    const cleanup = withResolvers<void>();
    const release = withResolvers<void>();
    yield* ensure(() => release.resolve());
    yield* ReplTerminal.around({
      *setRaw([enabled], next) {
        if (!enabled) {
          cleanup.resolve();
          yield* release.operation;
        }
        return yield* next(enabled);
      },
    });
    let returned = false;
    const opening = yield* spawn(function* () {
      const result = yield* prepareReplStartup(held.location, held.host.root);
      returned = true;
      return result;
    });
    yield* awaited("the offer", () => terminal.terminal.drawn > 1);
    terminal.terminal.end();
    yield* cleanup.operation;
    expect(returned).toBe(false);
    release.resolve();
    expect((yield* opening).ok).toBe(false);
    expect(terminal.terminal.readers).toBe(0);
    expect(yield* readTextFile(held.files.entries)).toBe(held.entries);
  });

  it("1113: an unfinished placement-less admission refuses without upgrading bytes", function* () {
    const held = yield* saved();
    const opened = yield* held.host.repository.open(held.id);
    const events = (yield* opened.stream.readAll()).map((event) => {
      if (event.type !== "yield" || event.description.name !== "__root__") {
        return event;
      }
      const { [PLACEMENT]: _placement, ...description } = event.description;
      return { ...event, description };
    });
    const bytes = events.map(serializeDurableEvent).join("");
    yield* writeTextFile(held.files.entries, bytes);
    const result = yield* prepareReplStartup(held.location, held.host.root, false);
    expect(!result.ok && result.error.message).toContain("no recorded project placement");
    expect(yield* readTextFile(held.files.entries)).toBe(bytes);
  });

  for (const sidekick of [false, true]) {
    it(`1113: CLI acceptance selects A before plugin loading for ${sidekick ? "Sidekick" : "manual"} continuation`, function* () {
      const held = yield* saved(sidekick);
      const other = yield* useTemporary("1113-other-");
      yield* ensureDir(join(held.project, "components"));
      yield* ensureDir(join(other, "components"));
      yield* writeTextFile(join(held.project, "components/Where.md"), "<Cwd />");
      yield* writeTextFile(join(other, "components/Where.md"), "wrong launch B");
      yield* API.Env.around(
        {
          *cwd() {
            return other;
          },
        },
        { at: "min" },
      );
      yield* writeTextFile(join(held.project, "acknowledged"), "external edit");
      yield* Permissions.around({
        files: ([operation], next) => (operation === "write" ? false : next(operation)),
      });
      const resumedDirectories: string[] = [];
      const continueEntry = withResolvers<void>();
      yield* Elicitation.around({
        *elicit([request], next) {
          if (request.message === "Wait here.") {
            resumedDirectories.push(yield* cwd());
            yield* continueEntry.operation;
            return { answer: "continue" };
          }
          return yield* next(request);
        },
      });
      let repeated = 0;
      yield* API.Fs.around({
        *rename([from, to], next) {
          if (String(to).endsWith("/acknowledged")) {
            repeated += 1;
          }
          return yield* next(from, to);
        },
      });
      const screen = recordingTerminal();
      const loaded: string[] = [];
      let installed = 0;
      let selected = 0;
      const mountSources: string[] = [];
      const exitContext =
        createContext<(result: { status: number }) => import("effection").Operation<void>>("exit");
      yield* exitContext.set(function* () {});
      const command = yield* spawn(() =>
        runXmd(
          [
            "repl",
            held.location,
            "--plugin",
            "./plugin.ts",
            "--include",
            "./components",
            "--mount",
            "./mapped:/reference",
          ],
          function* () {},
          {
            provenance: "deno-source",
            currentVersion: "0.0.0-test",
            executablePath: "/nonexistent",
            platform: "darwin",
            architecture: "arm64",
          },
          function* () {
            throw new Error("no stdin");
          },
          function* (_specifier, directory) {
            loaded.push(directory);
            return {
              default: Plugin({
                name: "1113-project",
                *install() {
                  installed += 1;
                  return undefined;
                },
              }),
            };
          },
          unsupportedWorkflowHost,
          undefined,
          {
            install: () => screen.install(),
            *select() {
              selected += 1;
              yield* ReplEntryHost.set((owner, placement) => {
                mountSources.push(...(placement?.mounts ?? []).map((pair) => pair.source));
                return held.entryHost(owner, placement);
              });
            },
          },
        ),
      );
      yield* awaited("the startup question", () => screen.terminal.drawn > 1);
      expect(loaded).toEqual([]);
      expect(installed).toBe(0);
      expect(selected).toBe(0);
      expect(yield* readTextFile(held.files.entries)).toBe(held.entries);
      const rows = screen.terminal.screen?.rows() ?? [];
      const row = rows.findIndex((text) => text.includes("( ) Return to "));
      expect(row).toBeGreaterThan(-1);
      const column = columnOf(screen.terminal.screen?.cells()[row] ?? [], "Return to ");
      screen.terminal.feed(`\x1b[<0;${column + 1};${row + 1}M\x1b[<0;${column + 1};${row + 1}m`);
      yield* awaited("selected project plugin", () => loaded.length > 0);
      expect(loaded).toEqual([held.project]);
      expect(installed).toBe(1);
      expect(selected).toBe(1);
      yield* awaited("resumed question", () => resumedDirectories.length > 0);
      expect(resumedDirectories).toEqual([held.project]);
      expect(repeated).toBe(0);
      expect(yield* readTextFile(join(held.project, "acknowledged"))).toBe("external edit");
      continueEntry.resolve();
      yield* awaitedFact("resumed entry completion", function* () {
        const reopened = yield* held.host.repository.open(held.id);
        const model = projectRepl(yield* reopened.stream.readAll());
        return model.ok && model.value.entries[0]?.settled === true;
      });
      const reopened = yield* held.host.repository.open(held.id);
      const model = projectRepl(yield* reopened.stream.readAll());
      expect(model.ok && model.value.entries[0]?.terminal?.output).toBe(held.project);
      expect(yield* readTextFile(join(held.project, "acknowledged"))).toBe("external edit");
      expect(mountSources).toEqual([join(held.project, "mapped")]);
      screen.terminal.feed('<Where /><File path="new-work">denied</File>\r');
      yield* awaitedFact("new entry in A", function* () {
        const reopened = yield* held.host.repository.open(held.id);
        const model = projectRepl(yield* reopened.stream.readAll());
        return model.ok && model.value.entries[1]?.settled === true;
      });
      const later = yield* held.host.repository.open(held.id);
      const laterModel = projectRepl(yield* later.stream.readAll());
      expect(laterModel.ok && laterModel.value.entries[1]?.terminal?.output).toContain(
        held.project,
      );
      expect(yield* exists(join(held.project, "new-work"))).toBe(false);
      expect(yield* cwd()).toBe(other);
      screen.terminal.end();
      yield* command;
      expect(screen.terminal.readers).toBe(0);
    });
  }

  it("1113: an unavailable or changed canonical original refuses without an offer", function* () {
    const held = yield* saved();
    const other = yield* useTemporary("1113-other-");
    yield* API.Env.around(
      {
        *cwd() {
          return other;
        },
      },
      { at: "min" },
    );
    const moved = join(yield* useTemporary("1113-relocated-"), "project");
    yield* ensure(function* () {
      if (yield* exists(moved)) {
        yield* rm(held.project, { force: true });
        yield* until(rename(moved, held.project));
      }
    });
    yield* until(rename(held.project, moved));
    const missing = yield* prepareReplStartup(held.location, held.host.root);
    expect(!missing.ok && missing.error.message).toContain("unavailable");
    yield* writeTextFile(held.project, "not a directory");
    const file = yield* prepareReplStartup(held.location, held.host.root);
    expect(!file.ok && file.error.message).toContain("unavailable");
    yield* rm(held.project);
    yield* until(symlink(other, held.project, "dir"));
    const replaced = yield* prepareReplStartup(held.location, held.host.root);
    expect(!replaced.ok && replaced.error.message).toContain("different directory");
    expect(yield* readTextFile(held.files.entries)).toBe(held.entries);
  });

  it("1113: a finalized profile with changed file roots refuses without installation", function* () {
    const held = yield* saved();
    const startup = yield* prepareReplStartup(held.location, held.host.root, false);
    if (!startup.ok) {
      throw startup.error;
    }
    yield* scoped(function* () {
      let initialized = 0;
      const selected = yield* useMountedHost({
        projectCwd: held.project,
        dataRoot: held.host.root,
        hostFiles: true,
        plugins: [
          Plugin({
            name: "startup-refusal-counter",
            *install(): Operation<ReplPluginInstallation> {
              yield* sleep(0);
              return {
                repl: {
                  *initialize() {
                    initialized++;
                    yield* sleep(0);
                  },
                },
              };
            },
          }),
        ],
      });
      const profile = yield* selected.profile.finalize(held.files.directory, held.host.root);
      // Two contributions, named rather than counted: the mounted host prefixes
      // the command's own bundled checklist Plugin, and this case selected the
      // counter beside it. Asserting the names is what keeps this row about
      // what was collected rather than about how many things a profile has.
      const contributed = profile.repl ?? [];
      expect(
        contributed.flatMap((one) => [...(one.components ?? [])]).map((one) => one.name),
      ).toEqual(["Sidekick.Todo"]);
      // The counter contributed its `initialize` exactly once and declared no
      // component, so it was collected once and is still distinct.
      expect(contributed.filter((one) => (one.components ?? []).length === 0)).toHaveLength(1);
      expect(contributed).toHaveLength(2);
      if (profile.access === undefined) {
        throw new Error("missing host file roots");
      }
      const other = yield* useTemporary("1113-other-");
      const terminal = recordingTerminal();
      yield* terminal.install();
      const result = yield* runReplProgram({
        startup,
        profile: { ...profile, access: { ...profile.access, project: other } },
      });
      expect(!result.ok && result.error.message).toContain("different file roots");
      expect(initialized).toBe(0);
      expect(yield* readTextFile(held.files.entries)).toBe(held.entries);
      expect(yield* readTextFile(held.files.sidekick)).toBe(held.chat);
    });
  });

  it("1113: a present placement is strict and never guesses a missing member", function* () {
    expect(parseEntryPlacement({ projectDirectory: "/a" }).ok).toBe(false);
    expect(
      parseEntryPlacement({ projectDirectory: "/a", canonicalProjectRoot: "/a", version: 1 }).ok,
    ).toBe(false);
    expect(
      parseEntryPlacement({ projectDirectory: "relative", canonicalProjectRoot: "/a" }).ok,
    ).toBe(false);
  });
});

describe("1113: unavailable access and conflicting placement", () => {
  it("1113: diagnoses an access refusal without offering another path", function* () {
    const directory = yield* useTemporary("1113-inaccessible-");
    let accessed = "";
    let message = "";
    try {
      yield* validateProjectPlacement(
        { projectDirectory: directory, canonicalProjectRoot: yield* until(realpath(directory)) },
        function* (path) {
          accessed = path;
          throw new Error("EACCES");
        },
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(accessed).toBe(directory);
    expect(message).toContain("unavailable");
  });

  it("1113: a Submit/admission pair disagreement refuses before continuation", function* () {
    const held = yield* saved(true);
    const different = yield* useTemporary("1113-different-");
    const opened = yield* held.host.repository.open(held.id);
    const events = (yield* opened.stream.readAll()).map((event) =>
      event.type === "yield" && event.description.name === "__root__"
        ? {
            ...event,
            description: {
              ...event.description,
              [PLACEMENT]: { projectDirectory: different, canonicalProjectRoot: different },
            },
          }
        : event,
    );
    const bytes = events.map(serializeDurableEvent).join("");
    yield* writeTextFile(held.files.entries, bytes);
    const result = yield* prepareReplStartup(held.location, held.host.root);
    expect(!result.ok && result.error.message).toContain("placements disagree");
    expect(yield* readTextFile(held.files.entries)).toBe(bytes);
    expect(yield* readTextFile(held.files.sidekick)).toBe(held.chat);
  });
});
