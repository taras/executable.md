/**
 * The running REPL driven through its terminal and read from its presented
 * frames (#1013).
 *
 * Each row mounts the real command, acts through keystrokes and pointer
 * presses, and asserts two things about the same frame: what the command
 * reported placing — control keys, region rectangles, focus — and what
 * Termless shows in those cells. Expected sizes and words come from the
 * specification; nothing here asks production code where it put something.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import type { Operation } from "effection";

import { ENTRIES_FILE } from "../src/repl/sidekick/history.ts";
import { useReplPage } from "./support/mounted-page.ts";
import type { PageFrame, ReplPage } from "./support/mounted-page.ts";
import { draft, drawer, sidekick } from "./support/repl-page-adapters.ts";
import { appendGate, awaitedFact } from "./support/mounted-repl.ts";
import { settledReading } from "./support/mounted-history.ts";

const WIDE = { columns: 160, rows: 36 };
const MEDIUM = { columns: 120, rows: 30 };
const NARROW = { columns: 72, rows: 20 };
const BELOW = { columns: 60, rows: 15 };

/** One entry a person types on one line. */
const ENTRY = "One: alpha";

/** The draft carried across every size, with a space in it. */
const DRAFTED = "keep this draft";

/** The deferred tray and continuation control, offered at no size by this build. */
const NEVER_OFFERED = ["tray:queue", "follow"];

/** Submit one entry from the Draft and wait for the History rail to mark it settled. */
function* submitted(page: ReplPage, source: string, order: number): Operation<void> {
  yield* draft(page).type(source);
  yield* page.key("Enter");
  yield* page.until(`entry ${order} settling`, (frame) =>
    (frame.area("box:history")?.rows().join(" ") ?? "").includes(`${order} ✓`),
  );
}

/** What every drawable frame owes the size it was drawn for. */
function whole(frame: PageFrame): void {
  const where = `${frame.size.columns}x${frame.size.rows}`;
  expect({ where, rows: frame.rows.length }).toEqual({ where, rows: frame.size.rows });
  expect({
    where,
    overlong: frame.rows.filter((line) => line.length > frame.size.columns),
  }).toEqual({ where, overlong: [] });
  const outside = frame.controls.filter(
    ({ bounds }) =>
      bounds.x < 0 ||
      bounds.y < 0 ||
      bounds.x + bounds.width > frame.size.columns ||
      bounds.y + bounds.height > frame.size.rows,
  );
  expect({ where, outside: outside.map((one) => one.key) }).toEqual({ where, outside: [] });
}

describe("Page A3 — the screen resized, refused and recovered, through the terminal", () => {
  it("A3: 160 to 120 to 72, below the minimum, and back, at a retained position", function* () {
    const page = yield* useReplPage({ size: WIDE });
    yield* submitted(page, ENTRY, 1);

    // An earlier position, chosen in the History drawer the footer opens.
    yield* page.press("footer:history");
    yield* page.until("the History drawer opening", () => drawer(page).isOpen());
    expect(drawer(page).area().shows("History")).toBe(true);
    yield* drawer(page).choose("Entry 1 admitted");
    yield* page.until("a frozen position", (frame) =>
      (frame.area("box:history")?.rows().join(" ") ?? "").includes("reading earlier"),
    );
    yield* drawer(page).dismiss();
    yield* draft(page).type(DRAFTED);

    // Two Sends with one label, in two panes: two keys, each drawn in its own.
    const wide = page.frame();
    expect([wide.control("draft:send")?.text, wide.control("sidekick:send")?.text]).toEqual([
      "[send]",
      "[send]",
    ]);
    expect(wide.area("box:draft")?.contains("draft:send")).toBe(true);
    expect(wide.area("box:draft")?.contains("sidekick:send")).toBe(false);
    expect(sidekick(page).area()?.contains("sidekick:send")).toBe(true);
    expect(sidekick(page).area()?.contains("draft:send")).toBe(false);

    whole(wide);
    for (const size of [MEDIUM, NARROW]) {
      const frame = yield* page.resize(size);
      const where = `${size.columns}x${size.rows}`;
      whole(frame);
      expect({ where, focused: frame.focused }).toEqual({ where, focused: "footer:input" });
      expect({ where, draft: draft(page).text() }).toEqual({ where, draft: DRAFTED });
      // The band is cut to the room it has, and the way back to the head stays whole.
      expect({
        where,
        band: frame.area("box:history")?.shows("HEAD \u00b7 SETTLED \u00b7 reading"),
        live: frame.control("footer:live")?.text,
      }).toEqual({ where, band: true, live: "[live]" });
      expect({ where, offered: NEVER_OFFERED.filter((key) => frame.has(key)) }).toEqual({
        where,
        offered: [],
      });
    }
    // Narrow routes one outlet, and an idle Sidekick gives it to Entries.
    expect(page.frame().has("sidekick:message")).toBe(false);
    expect(page.frame().profile).toBe("narrow");

    // Below the minimum the frame is its own refusal: no control anywhere.
    const refused = yield* page.resize(BELOW);
    expect(refused.profile).toBe("too-small");
    expect(refused.keys()).toEqual([]);
    expect(refused.rows.join(" ")).toContain("needs at least 72x20");

    // A key the frame did not place is refused, naming what was.
    const absent = yield* refusal(page.press("draft:send"));
    expect(absent).toContain("no control draft:send is placed");

    const recovered = yield* page.resize(WIDE);
    whole(recovered);
    expect(recovered.focused).toBe("footer:input");
    expect(draft(page).text()).toBe(DRAFTED);
    expect(recovered.area("box:history")?.shows("reading earlier")).toBe(true);
    expect(recovered.has("tray:todo")).toBe(true);
    expect(NEVER_OFFERED.filter((key) => recovered.has(key))).toEqual([]);
  });

  it("A3: an open drawer keeps focus and typing through a resize, and gives focus back", function* () {
    const page = yield* useReplPage({ size: WIDE });
    yield* draft(page).type(DRAFTED);
    yield* sidekick(page).composer.type("asked");

    yield* page.press("footer:history");
    yield* page.until("the History drawer opening", () => drawer(page).isOpen());
    yield* page.resize(MEDIUM);
    expect(drawer(page).isOpen()).toBe(true);
    whole(page.frame());

    // Tab stays inside the modal: its own controls, and the way out the
    // specification says belongs to it while it is open.
    const reached = new Set<string>();
    const presses = page.frame().keys().length + 1;
    for (let press = 0; press < presses; press += 1) {
      const before = page.frame().focused;
      yield* page.key("Tab");
      const moved = yield* page.until("Tab moving focus", (frame) => frame.focused !== before);
      reached.add(moved.focused ?? "");
    }
    const layer = drawer(page).area();
    expect(
      [...reached].filter((key) => !layer.contains(key) && !key.startsWith("footer:")),
    ).toEqual([]);
    expect([...reached].some((key) => layer.contains(key))).toBe(true);

    // Typing reaches neither field behind it.
    yield* page.type("stray");
    yield* page.key("Escape");
    yield* page.until("the drawer closing", () => !drawer(page).isOpen());
    expect(draft(page).text()).toBe(DRAFTED);
    expect(sidekick(page).composer.text()).toBe("asked");
    expect(page.frame().focused).toBe("sidekick:message");
  });
});

/**
 * Stop as the control a person presses (#883 M6).
 *
 * Both rows hold something external open — an entry's closing record, or the
 * provider's cancellation — because a Stop that returned early and one that
 * joined everything it owned look the same otherwise.
 */
describe("Page M6 — Stop, pressed on the screen", () => {
  /** A reply that prepares an entry and submits it. */
  const SUBMITTING_REPLY = [
    '<Let as="code" select="code">',
    "````xmd",
    "```js eval",
    'const held = "the entry kept running";',
    "```",
    "",
    "<Output>{held}</Output>",
    "````",
    "</Let>",
    "<REPL.EntryInput>{code}</REPL.EntryInput>",
    "<REPL.Submit />",
    "",
  ].join("\n");

  it("M6: Stop withdraws the wait and leaves the entry it admitted running", function* () {
    const gate = appendGate();
    const page = yield* useReplPage({ gate });
    const { repl } = page;
    repl.fake.script({ reply: SUBMITTING_REPLY });

    // The entry's own closing record, held open: the entry has run and has not
    // settled, which is where the submission is still waiting for its outcome.
    const closing = gate.holdNext(
      (path, record) => path.endsWith(ENTRIES_FILE) && record.includes('"type":"close"'),
    );

    yield* sidekick(page).send("run it");
    yield* closing.started();
    const both = yield* page.until(
      "the entry's output, with both Stops offered",
      (frame) =>
        (frame.area("box:transcript")?.shows("the entry kept running") ?? false) &&
        frame.has("draft:stop") &&
        frame.has("sidekick:stop"),
    );
    // Two Stops with one label: the entry's in the Draft, the Sidekick's in its pane.
    expect([both.control("draft:stop")?.text, both.control("sidekick:stop")?.text]).toEqual([
      "[stop]",
      "[stop]",
    ]);
    expect(both.area("box:draft")?.contains("draft:stop")).toBe(true);
    expect(both.area("box:inspection")?.contains("sidekick:stop")).toBe(true);

    yield* sidekick(page).stop();
    const idle = yield* page.until(
      "Stop joining and the Sidekick coming to rest",
      (frame) => frame.has("sidekick:send") && !frame.has("sidekick:stop"),
    );
    // The entry's own Stop is still there: the Sidekick's reached no further.
    expect(idle.has("draft:stop")).toBe(true);

    // No turn followed, and the submission's intent is retained with no outcome.
    expect(repl.fake.prompts).toHaveLength(1);
    const stopped = yield* settledReading(repl);
    const controls = stopped.chat.filter((record) => record.kind === "control");
    const answered = new Set(
      stopped.chat
        .filter((record) => record.kind === "control-outcome")
        .map((record) => (record.kind === "control-outcome" ? record.order : -1)),
    );
    expect(controls.map((record) => (record.kind === "control" ? record.component : ""))).toEqual([
      "REPL.EntryInput",
      "REPL.Submit",
    ]);
    expect(
      controls
        .filter((record) => !answered.has(record.kind === "control" ? record.order : -1))
        .map((record) => (record.kind === "control" ? record.component : "")),
    ).toEqual(["REPL.Submit"]);
    expect(sidekick(page).area()?.shows("run it")).toBe(true);
    expect(draft(page).text()).toBe("");

    // The entry settles when its own record lands, not when Stop said so.
    expect(stopped.model.entries.map((entry) => entry.terminal)).toEqual([undefined]);
    closing.release();
    yield* page.until("the rail marking entry 1 settled", (frame) =>
      (frame.area("box:history")?.rows().join(" ") ?? "").includes("1 ✓"),
    );
    yield* awaitedFact("entry 1 closing on disk", function* () {
      const read = yield* settledReading(repl);
      return read.model.entries[0]?.terminal?.status === "ok";
    });

    // Stop ended the asking, not the conversation.
    repl.fake.script({ reply: "<Output>Still here.</Output>\n" });
    yield* sidekick(page).send("again");
    yield* page.until(
      "the next message being answered",
      () => sidekick(page).area()?.shows("Still here.") ?? false,
    );
    expect(repl.fake.prompts).toHaveLength(2);
  });

  it("M6: Stop reports nothing and enables no successor while its cleanup is held", function* () {
    const page = yield* useReplPage();
    const { repl } = page;
    repl.fake.script({ held: true, reply: "<Output>Never said.</Output>\n" });
    const cancelling = repl.fake.holdCancellation();

    yield* sidekick(page).send("stop me");
    yield* repl.fake.holdingTurns(1);
    yield* page.until("the Sidekick working", () => sidekick(page).working());
    yield* sidekick(page).stop();
    yield* cancelling.reached;

    // Stop is inside the teardown it asked for: still working, no Send to start
    // a successor with, while the Draft's own Send stays where it always is.
    const held = page.frame();
    expect(sidekick(page).working()).toBe(true);
    expect(held.control("sidekick:stop")?.text).toBe("[stop]");
    expect(sidekick(page).area()?.shows("[send]")).toBe(false);
    expect(held.control("draft:send")?.text).toBe("[send]");
    expect(repl.fake.prompts).toHaveLength(1);

    // Typing still works, because the join is on the screen's task, not the keyboard's.
    yield* draft(page).type("meanwhile");
    expect(draft(page).text()).toBe("meanwhile");

    cancelling.release();
    yield* page.until(
      "Stop returning once its cleanup joined",
      (frame) => frame.has("sidekick:send") && !frame.has("sidekick:stop"),
    );
    expect(sidekick(page).area()?.shows("[send]")).toBe(true);
    expect(draft(page).text()).toBe("meanwhile");
    expect(repl.fake.prompts).toHaveLength(1);
  });
});

/** The message an operation refused with. */
function* refusal(attempt: Operation<void>): Operation<string> {
  try {
    yield* attempt;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("the operation was expected to refuse, and it completed");
}
