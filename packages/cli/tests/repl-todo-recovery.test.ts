import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, scoped, spawn, suspend, withResolvers } from "effection";
import { readTextFile, writeTextFile } from "@effectionx/fs";
import { Repl } from "../src/api.ts";
import { useReplPage } from "./support/repl-page.ts";
import { intoComposer, sendMessage, pasteDraft } from "./support/screen-journeys.ts";
import { awaitedFact, useMountedHost, useMountedRepl } from "./support/mounted-repl.ts";
import { settledReading } from "./support/mounted-history.ts";
import { pairedLocation } from "../src/repl/sidekick/history.ts";
import { todoWakeEligible } from "../src/repl/todo/wake.ts";

describe("TODO logical runtime recovery", () => {
  it("restores only file state and initializes once per open logical runtime", function* () {
    let initialized = 0;
    let cleaned = 0;
    yield* Repl.around({
      *initialize([workspace], next) {
        initialized++;
        yield* ensure(() => {
          cleaned++;
        });
        yield* next(workspace);
      },
    });
    const first = yield* useReplPage();
    yield* intoComposer(first);
    first.repl.fake.script({ reply: "incomplete", stopReason: "max_tokens" });
    yield* first.press("+", { onRow: "TODO" });
    yield* first.until("editor", (one) => one.shows("Task:"));
    yield* first.type("saved before failure");
    yield* first.key("Enter");
    yield* first.repl.fake.startedTurns(1);
    yield* first.until("failed wake held", (one) => one.shows("Resume queue"));
    const read = yield* settledReading(first.repl);
    const file = pairedLocation(first.repl.root, read.execution).directory + "/todo.md";
    first.repl.terminal.end();
    yield* awaitedFact("first runtime joined", function* () {
      return first.repl.outcome() !== undefined;
    });
    const outcome = first.repl.outcome();
    if (!outcome?.ok) {
      throw new Error("First runtime did not exit normally.");
    }
    expect(initialized).toBe(1);
    expect(cleaned).toBe(1);
    yield* writeTextFile(file, "- [x] current after close\n");
    const reopened = yield* useReplPage({ host: first.repl, location: outcome.value.location });
    yield* intoComposer(reopened);
    yield* reopened.until("saved checklist on reopen", (one) => one.shows("current after close"));
    expect(initialized).toBe(2);
    expect(reopened.repl.fake.prompts).toHaveLength(1);
    reopened.repl.fake.script({ reply: "<Output>explicit after reopen</Output>" });
    yield* sendMessage(reopened, "explicit after reopen");
    yield* reopened.until("explicit result", (one) => one.shows("[S] explicit after reopen"));
    expect(reopened.repl.fake.prompts[1]).not.toContain("fresh recovery state");
    expect(reopened.repl.fake.prompts[1]).not.toContain("Committed TODO changes");
    expect(yield* readTextFile(file)).toBe("- [x] current after close\n");
    reopened.repl.terminal.end();
    yield* awaitedFact("reopened runtime joined", function* () {
      return reopened.repl.outcome() !== undefined;
    });
    expect(cleaned).toBe(2);
  });

  it("joins partial initialization on failure and cancellation before activation", function* () {
    const host = yield* useMountedHost();
    let cleaned = false;
    let failure: unknown;
    try {
      yield* scoped(function* () {
        yield* Repl.around({
          *initialize() {
            yield* ensure(() => {
              cleaned = true;
            });
            throw new Error("initialization refused");
          },
        });
        const page = yield* useReplPage({ host });
        yield* page.until("unreachable activation", () => false);
      });
    } catch (error) {
      failure = error;
    }
    expect(failure instanceof Error && failure.message).toContain("initialization refused");
    expect(cleaned).toBe(true);
    expect(host.fake.prompts).toEqual([]);
    const entered = withResolvers<void>();
    const cleaning = withResolvers<void>();
    const release = withResolvers<void>();
    const worker = yield* spawn(function* () {
      yield* Repl.around({
        *initialize() {
          yield* ensure(function* () {
            cleaning.resolve();
            yield* release.operation;
          });
          entered.resolve();
          yield* suspend();
        },
      });
      yield* useMountedRepl({ host });
      yield* suspend();
    });
    yield* entered.operation;
    let joined = false;
    const stopping = yield* spawn(function* () {
      yield* worker.halt();
      joined = true;
    });
    yield* cleaning.operation;
    expect(joined).toBe(false);
    expect(host.fake.prompts).toEqual([]);
    release.resolve();
    yield* stopping;
    expect(joined).toBe(true);
  });

  it("vetoes a human wake while an admitted entry still owns joined cleanup", function* () {
    const cleaning = withResolvers<void>();
    const release = withResolvers<void>();
    const page = yield* useReplPage({
      entryInstallation: function* () {
        return {
          *install() {
            yield* ensure(function* () {
              cleaning.resolve();
              yield* release.operation;
            });
          },
        };
      },
    });
    yield* pasteDraft(page, "<Output>entry finished</Output>");
    yield* page.key("Enter");
    yield* cleaning.operation;
    yield* intoComposer(page);
    yield* page.press("+", { onRow: "TODO" });
    yield* page.until("task editor during entry cleanup", (one) => one.shows("Task:"));
    yield* page.type("pending during cleanup");
    yield* page.key("Enter");
    yield* page.until(
      "committed task during entry cleanup",
      (one) => one.shows("pending during cleanup") && !one.shows("Task:"),
    );
    expect(page.repl.fake.prompts).toEqual([]);
    release.resolve();
    yield* page.until("entry cleanup joined", (one) => one.shows("Ready for Entry 2"));
    expect(page.repl.fake.prompts).toEqual([]);
    page.repl.fake.script({ reply: "<Output>independently requested</Output>" });
    yield* sendMessage(page, "explicit after cleanup");
    yield* page.until("explicit response", (one) => one.shows("[S] independently requested"));
    expect(page.repl.fake.prompts[0]).toContain('"text":"pending during cleanup"');
    page.repl.terminal.end();
    yield* awaitedFact("cleanup witness command joined", function* () {
      return page.repl.outcome() !== undefined;
    });
  });

  it("exports a neutral no-op initialization API with the existing runtime roots", function* () {
    yield* scoped(function* () {
      yield* Repl.operations.initialize("unused");
    });
    const deno = JSON.parse(yield* readTextFile(new URL("../deno.json", import.meta.url)));
    const npm = JSON.parse(yield* readTextFile(new URL("../package.json", import.meta.url)));
    expect(deno.exports).toEqual({ ".": "./src/deno.ts", "./api": "./src/api.ts" });
    expect(npm.exports["."]).toEqual({ bun: "./src/bun.ts", default: "./src/node.ts" });
    expect(npm.exports["./api"]).toBe("./src/api.ts");
    const source = yield* readTextFile(new URL("../src/api.ts", import.meta.url));
    expect(source).toContain("./repl-api.ts");
    expect(source).not.toContain("./deno.ts");
    expect(source).not.toContain("./node.ts");
  });

  it("requires every whole-host readiness fact before a human wake", function* () {
    const ready = {
      live: true,
      storage: true,
      entry: true,
      reservation: true,
      dispatch: true,
      configuration: true,
      questions: true,
      permissions: true,
      conversation: true,
    };
    expect(todoWakeEligible(ready)).toBe(true);
    for (const key of Object.keys(ready)) {
      expect(todoWakeEligible({ ...ready, [key]: false })).toBe(false);
    }
  });
});
