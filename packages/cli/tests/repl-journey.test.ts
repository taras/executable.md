/** The mounted REPL journey, driven by terminal input and visible outcomes. */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { scoped, spawn, suspend } from "effection";
import type { Operation } from "effection";
import { awaited } from "./support/mounted-repl.ts";
import type { MountedRepl } from "./support/mounted-repl.ts";

import { useReplPage } from "./support/repl-page.ts";
import {
  closeDrawer,
  DRAFT_VALUE,
  draftHolds,
  draftText,
  entrySettles,
  openHistory,
  pasteDraft,
} from "./support/screen-journeys.ts";

const WIDE = { columns: 160, rows: 36 };
const NARROW = { columns: 72, rows: 20 };

describe("REPL journey: a person drives the running command", () => {
  it("submits a Draft through the terminal and sees its settled History mark", function* () {
    const page = yield* useReplPage({ size: WIDE });
    yield* pasteDraft(page, 'output("one done");');
    yield* page.key("Enter");
    yield* entrySettles(page, 1, "ok");
    expect(page.screen().shows("one done")).toBe(true);
    expect(page.screen().shows("1 ✓")).toBe(true);
  });

  it("keeps the Draft across a modal and a resize", function* () {
    const page = yield* useReplPage({ size: WIDE });
    yield* draftText(page, "draft survives");
    yield* openHistory(page);
    expect(page.screen().shows("[close]")).toBe(true);
    yield* closeDrawer(page);
    const narrow = yield* page.resize(NARROW);
    expect(narrow.found("draft survives", { after: " DRAFT" })).toBe(1);
    const wide = yield* page.resize(WIDE);
    expect(wide.found("draft survives", DRAFT_VALUE)).toBe(1);
  });

  it("publishes no screen reading while a terminal write is held", function* () {
    const page = yield* useReplPage({ size: WIDE });
    const terminal = page.repl.terminal;
    const before = page.screen().index;
    terminal.holdNextPresent();
    yield* page.type("held until released");
    yield* awaited("the held write", () => terminal.holdPresent !== undefined);
    expect(page.screen().index).toBe(before);
    expect(page.screen().shows("held until released")).toBe(false);
    terminal.holdPresent?.release();
    yield* page.until(
      "the held write landing",
      (one) => one.shows("held until released"),
    );
  });

  it("hands a failed presentation to the command owner unchanged", function* () {
    const failure = new Error("presentation failed");
    let mounted: MountedRepl | undefined;
    let caught: unknown;
    try {
      yield* scoped(function* (): Operation<void> {
        const page = yield* useReplPage({ size: WIDE });
        mounted = page.repl;
        yield* spawn(() =>
          page.until("a screen that never arrives", () => false)
        );
        yield* awaited(
          "a wait subscribed to the next frame",
          () => page.repl.terminal.waiting === 1,
        );
        page.repl.terminal.failNextPresent(failure);
        yield* page.key("Tab");
        yield* suspend();
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(failure);
    expect(mounted?.outcome()).toBeUndefined();
  });
});
