/**
 * The one-entry product journey (#848 J1, S1, D1).
 *
 * A real terminal's worth of bytes in, a real terminal's worth of bytes out, and
 * a real durable execution in between. The terminal is injected, so the same
 * corpus runs under Deno, Node and Bun; everything else — the repository, the
 * session, the keyed tree, the layout, the renderer — is the production assembly
 * the command uses.
 *
 * A row acts through terminal input and reads one presented frame: the control
 * keys, region rectangles and focus the command reported for it, beside the
 * cells the terminal showed. What a terminal's cursor addressing looks like is
 * the renderer's business and changes when it optimizes; what a person can read
 * on the screen is the product.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import {
  ensure,
  type Operation,
  type Result,
  scoped,
  sleep,
  spawn,
  suspend,
  withResolvers,
} from "effection";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { until } from "effection";

import { API } from "@executablemd/runtime";
import { Elicitation, Execution, useTempFileCompiler } from "@executablemd/core";
import { RootMetadata } from "@executablemd/core/api";
import { ENTRIES_FILE, PAIRED_DIRECTORY } from "../src/repl/sidekick/history.ts";
import type { ReplTerminalSize } from "../src/repl/terminal.ts";
import { ReplClock } from "../src/repl/frame.ts";
import { ReplHost } from "../src/repl/host.ts";
import { ReplFrameWitness } from "../src/repl/frame-witness.ts";
import {
  COMPACT_HISTORY_TITLE,
  describeApplication,
  initialState,
  NO_AGENT,
  reduceRepl,
  refusedView,
} from "../src/repl/application.ts";
import { NO_LIFECYCLE } from "../src/repl/lifecycle.ts";
import { readDescription } from "../src/repl/description.ts";
import { runReplProgram } from "../src/repl/program.ts";
import type { ReplOutcome } from "../src/repl/program.ts";
import { parseDurableEvent, serializeDurableEvent } from "@executablemd/durable-streams";
import { projectRepl } from "../src/repl/model.ts";
import type { ReplModel } from "../src/repl/model.ts";
import { decodeLocation, encodeLocation } from "../src/repl/route.ts";
import type { ReplRoute } from "../src/repl/route.ts";
import {
  REFERENCE_DIRECTORY,
  referenceEvents,
  referenceSource,
} from "./fixtures/repl/reference.ts";
import { measuringContext } from "./fixtures/repl/presentation.ts";
import { useTemporary } from "./fixtures/repl/issue-883/sidekick-harness.ts";
import { awaited, awaitedFact, recordingTerminal, useMountedHost } from "./support/mounted-repl.ts";
import type { MountedHost, Terminal } from "./support/mounted-repl.ts";
import { useReplPage } from "./support/mounted-page.ts";
import type { PageFrame, ReplPage } from "./support/mounted-page.ts";
import {
  catalogOpen,
  closeCatalog,
  draft,
  entrySettles,
  frameAt,
  form,
  openCatalog,
  paste,
  railEntries,
  scrollUntil,
  selectPane,
  shows,
  sidekick,
} from "./support/repl-page-adapters.ts";

const WIDE: ReplTerminalSize = { columns: 160, rows: 36 };
const MEDIUM: ReplTerminalSize = { columns: 120, rows: 30 };
const NARROW: ReplTerminalSize = { columns: 72, rows: 20 };
const BELOW_MINIMUM: ReplTerminalSize = { columns: 60, rows: 15 };

/** The normalized schema the reference entry's question is judged against. */
const SCHEMA = {
  type: "object",
  properties: { decision: { type: "string", enum: ["approve", "decline"] } },
  required: ["decision"],
  additionalProperties: false,
};

/** What the reference entry's eval publishes, as the model retains it. */
const PLAN = { title: "Ship the REPL", steps: 2 };

/** The answer this journey gives it. */
const ANSWER = { decision: "approve" };

/** A model with nothing in it, which is what a fresh execution projects. */
const EMPTY_MODEL_FOR_TEST = Object.freeze({
  selection: undefined,
  head: true,
  entries: Object.freeze([]),
  settled: false,
  terminal: undefined,
  checkpoints: Object.freeze([]),
  transcript: Object.freeze([]),
  turns: Object.freeze([]),
  sessions: Object.freeze([]),
});

/** A clock the test moves, so nothing in this suite waits on real time. */
function immediateClock(): Operation<void> {
  return ReplClock.around(
    {
      // deno-lint-ignore require-yield
      *now(): Operation<number> {
        return 0;
      },
      // deno-lint-ignore require-yield
      *wait(): Operation<void> {
        // Returns at once: this product draws when something changed, so the
        // frame interval is the only thing being skipped.
      },
    },
    { at: "min" },
  );
}

/**
 * A clock that records what was scheduled and, once held, releases it only when told.
 *
 * Until `hold()` it answers each wait at once, so the command can start and the
 * first frames can be presented before a case begins to count.
 */
interface CountingClock {
  waits: number;
  /** How many waits are parked, held until the next release. */
  parked(): number;
  install(): Operation<void>;
  hold(): void;
  release(): void;
}

function countingClock(): CountingClock {
  let pending: (() => void)[] = [];
  let holding = false;
  const clock: CountingClock = {
    waits: 0,
    install(): Operation<void> {
      return ReplClock.around(
        {
          // deno-lint-ignore require-yield
          *now(): Operation<number> {
            return 0;
          },
          *wait(): Operation<void> {
            clock.waits += 1;
            if (!holding) {
              return;
            }
            const waiter = withResolvers<void>();
            pending.push(() => waiter.resolve());
            yield* waiter.operation;
          },
        },
        { at: "min" },
      );
    },
    parked: () => pending.length,
    hold(): void {
      holding = true;
    },
    release(): void {
      const releasing = pending;
      pending = [];
      for (const one of releasing) {
        one();
      }
    },
  };
  return clock;
}

/** What a run really performed, as opposed to what it restored. */
interface Performed {
  /** Component sources actually read from disk. */
  reads: string[];
  /** Eval blocks actually compiled, which is where a block really runs. */
  compiles: number;
  /** Questions a provider was actually asked. */
  asked: number;
}

/**
 * Count the work a run performs, at the seams where performing it happens.
 *
 * Not at the durable operations: replay enters those and hands back what was
 * recorded, so counting them would count restoration as work. A component's
 * source is read inside the recorded selection and an eval block is compiled
 * inside the recorded evaluation, so these counts are zero for anything a cold
 * open restored rather than ran.
 */
function* countPerformed(): Operation<Performed> {
  const performed: Performed = { reads: [], compiles: 0, asked: 0 };
  yield* API.Fs.around({
    *readTextFile([path], next) {
      performed.reads.push(path);
      return yield* next(path);
    },
  });
  yield* API.Env.around({
    *compile([source, options], next) {
      performed.compiles++;
      return yield* next(source, options);
    },
  });
  yield* Elicitation.around({
    *elicit([request], next) {
      performed.asked++;
      return yield* next(request);
    },
  });
  return performed;
}

/**
 * A host in which nothing may start an execution or create a file.
 *
 * A reopen mints no identifier and creates no file, so both are refusals rather
 * than values: a cold open that quietly made either would not be a cold open.
 */
function* refuseNewExecutions(): Operation<void> {
  yield* ReplHost.around(
    {
      // deno-lint-ignore require-yield
      *identify(): Operation<string> {
        throw new Error("a reopened execution mints no identifier");
      },
      // deno-lint-ignore require-yield
      *createExclusive(): Operation<void> {
        throw new Error("a reopened execution creates no file");
      },
    },
    { at: "max" },
  );
}

/** One host over a data root, and the root it keeps its executions under. */
interface JourneyHost {
  readonly host: MountedHost;
  readonly root: string;
}

/**
 * Install a REPL host over a data root, and the clock a row does not wait on.
 *
 * A row that reopens an execution names the root the first process left and
 * asks for `reopening`, so a reopen that started an execution would fail where
 * it did so.
 */
function* useJourneyHost(
  options: {
    readonly root?: string;
    readonly reopening?: boolean;
    readonly clock?: CountingClock;
  } = {},
): Operation<JourneyHost> {
  const root = options.root ?? (yield* useTemporary("xmd-repl-journey-"));
  if (options.reopening === true) {
    yield* refuseNewExecutions();
  }
  const host = yield* useMountedHost({ dataRoot: root, includes: [REFERENCE_DIRECTORY] });
  if (options.clock === undefined) {
    yield* immediateClock();
  } else {
    yield* options.clock.install();
  }
  return { host, root };
}

/** The running command, mounted over a host. */
function* startJourney(
  hosted: JourneyHost,
  options: { readonly size?: ReplTerminalSize; readonly location?: string } = {},
): Operation<ReplPage> {
  return yield* useReplPage({
    host: hosted.host,
    ...(options.size === undefined ? {} : { size: options.size }),
    ...(options.location === undefined ? {} : { location: options.location }),
  });
}

/** The running command over a fresh data root, or over the root a reopen names. */
function* mountJourney(
  options: {
    readonly size?: ReplTerminalSize;
    readonly location?: string;
    readonly root?: string;
    readonly reopening?: boolean;
  } = {},
): Operation<{ readonly page: ReplPage; readonly root: string }> {
  const hosted = yield* useJourneyHost({
    ...(options.root === undefined ? {} : { root: options.root }),
    ...(options.reopening === undefined ? {} : { reopening: options.reopening }),
  });
  const page = yield* startJourney(hosted, options);
  return { page, root: hosted.root };
}

/** The command's outcome, once it has returned. */
function* outcomeOf(page: ReplPage): Operation<Result<ReplOutcome>> {
  yield* awaited("the command returning", () => page.repl.outcome() !== undefined);
  const outcome = page.repl.outcome();
  if (outcome === undefined) {
    throw new Error("the command returned without an outcome");
  }
  return outcome;
}

/** Give the terminal back the way a closed input does, and wait for the command to return. */
function* finish(page: ReplPage): Operation<void> {
  page.repl.terminal.end();
  const outcome = yield* outcomeOf(page);
  if (!outcome.ok) {
    throw outcome.error;
  }
}

/** The command's own ordinary return, which a row leaves it by. */
function* returned(page: ReplPage): Operation<ReplOutcome> {
  const outcome = yield* outcomeOf(page);
  if (!outcome.ok) {
    throw outcome.error;
  }
  return outcome.value;
}

/**
 * The canonical location this command returns when it ends.
 *
 * The one place a route is still published to someone outside the process. The
 * screen does not draw it any more, and this suite sees only what the screen
 * draws — so a scenario whose final state *is* a route asserts it here, after an
 * orderly exit, and asserts what it can see for everything before that.
 */
interface ExitRoute {
  /** The returned location, or a failure saying the command has not ended yet. */
  location(): string;
  /** The same location, decoded into the fields a scenario compares. */
  route(): ReplRoute;
}

function exitRoute(page: ReplPage): ExitRoute {
  const location = (): string => {
    const ended = page.repl.outcome();
    if (ended === undefined || !ended.ok) {
      throw new Error("this command has not ended, so it has returned no location");
    }
    return ended.value.location;
  };
  return {
    location,
    route() {
      const decoded = decodeLocation(location());
      if (!decoded.ok) {
        throw decoded.error;
      }
      return decoded.value;
    },
  };
}

/** Whether this reading is a retained position rather than the live head. */
function historical(frame: PageFrame): boolean {
  return frame.has("footer:live");
}

/** Whether the next keystroke reaches the draft. */
function draftFocused(frame: PageFrame): boolean {
  return frame.focused === "footer:input";
}

/** Whether a question is waiting on this process. */
function asked(frame: PageFrame): boolean {
  return frame.has("footer:asked");
}

/** Whether a control's text wears the mark of the surface or entry being read. */
function selectionMarked(text: string | undefined): boolean {
  return text !== undefined && /^(?:>\s+)?\*\s/.test(text);
}

/** Whether the draft rows are the last rows of this source, in order. */
function draftShows(page: ReplPage, source: string): boolean {
  const seen = (text: string): string[] =>
    text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "");
  const shown = seen(draft(page).text());
  const whole = seen(source);
  if (shown.length === 0 || shown.length > whole.length) {
    return false;
  }
  return whole.slice(whole.length - shown.length).join("\n") === shown.join("\n");
}

/** The guidance block as drawn: the sentence the screen tells a person. */
function guidanceRow(frame: PageFrame): string {
  return frame.area("box:guidance")?.rows()[0] ?? "";
}

/** Whether the frame's text, with each region's rails taken out and its rows rejoined, says this. */
function says(frame: PageFrame, region: string, expected: string): boolean {
  const flat = (text: string): string => text.replace(/│/g, " ").replace(/\s+/g, " ").trim();
  return flat(frame.area(region)?.rows().join(" ") ?? "").includes(flat(expected));
}

/** Whether the Transcript's reading says a token with no spaces, once its rows are rejoined as cut. */
function saysJoined(frame: PageFrame, expected: string): boolean {
  const joined = (frame.area("box:reading:viewport")?.rows() ?? [])
    .map((line) => line.replace(/^[\s│]+/, "").trimEnd())
    .join("");
  return joined.includes(expected);
}

/** The row the selected work names its way in, which is where the reading says which entry it is. */
function trailRow(frame: PageFrame): string {
  const header = frame.area("box:transcript:header") ?? frame.area("box:content:header");
  return header?.rows()[0] ?? "";
}

/** The entry the reading is of, from the selected work's own breadcrumb. */
function selectedEntry(frame: PageFrame): string | undefined {
  return /›\s*(Entry \d+)/.exec(trailRow(frame))?.[1];
}

/** The breadcrumb trail, from its first separator on. */
function crumbTrail(frame: PageFrame): string {
  const row = trailRow(frame);
  const at = row.indexOf("› ");
  return at === -1 ? "" : row.slice(at).trimEnd();
}

/** The surface a narrow frame routes, from the mark its heading wears. */
function routedSurface(frame: PageFrame): string | undefined {
  const headings: readonly (readonly [string, string])[] = [
    ["sessions:heading", "Sessions"],
    ["entries:heading", "Entries"],
  ];
  for (const [key, name] of headings) {
    if (selectionMarked(frame.control(key)?.text)) {
      return name;
    }
  }
  return undefined;
}

/**
 * Whether this frame routes one outlet, and which — or none, where it draws
 * every column at once.
 *
 * A shared width has no routed surface: the Transcript, the selected work and
 * the right pane are all on the screen, so "being on Sessions" is a state only
 * the narrow frame has. A row that asserts routing has to say which it means.
 */
function surfaceRouted(frame: PageFrame, expected: string): boolean {
  const routed = routedSurface(frame);
  if (routed !== undefined) {
    return routed === expected;
  }
  return expected === "Entries" ? shows(frame, "Entries") : shows(frame, "TRANSCRIPT");
}

/** Whether a question's form is open in the drawer, with its submit placed or scrolled out of the window. */
function formShowing(frame: PageFrame): boolean {
  return (
    frame.has("drawer:form:submit") ||
    (frame
      .area("box:drawer:layer")
      ?.rows()
      .some((line) => /^\s*Answer\b/.test(line)) ??
      false)
  );
}

/**
 * Reach the Transcript of agent work, whichever way this frame offers it.
 *
 * A narrow frame routes one outlet and names it in its own heading; a shared
 * width draws the Transcript beside the selected work and offers its
 * conversation selector instead. Either way what this leaves is focus inside
 * that reading and nothing else moved.
 */
function* toTranscript(page: ReplPage): Operation<void> {
  yield* closeCatalog(page);
  const routed = routedSurface(page.frame());
  if (routed === undefined) {
    yield* page.focus("transcript:selector");
    return;
  }
  if (routed === "Sessions") {
    return;
  }
  yield* page.focus("sessions:heading");
  yield* page.key("Enter");
  yield* page.until("the Transcript routed", (frame) => routedSurface(frame) === "Sessions");
}

/**
 * Reach the entries being read, whichever way this frame offers it.
 *
 * The control that routes this outlet is the same one that opens the catalog
 * over it, so arriving here leaves a drawer up — and the reading this is for is
 * underneath it. Put it away, so what follows is about the entries rather than
 * about the list of them.
 */
function* toEntries(page: ReplPage): Operation<void> {
  if (routedSurface(page.frame()) !== "Entries") {
    yield* openCatalog(page);
  }
  yield* closeCatalog(page);
}

/**
 * Open the waiting question's drawer, the way a person does.
 *
 * A question announces itself on one row and opens nothing: the drawer is what
 * activating that row does. Activation is by pointer because it needs no
 * traversal, and a pointer on a control asks for exactly what Enter on it asks
 * for.
 */
function* openQuestion(page: ReplPage): Operation<void> {
  yield* page.until("the waiting question announcing itself", asked);
  yield* page.press("footer:asked");
  yield* page.until("the question's form", formShowing);
}

/**
 * Open the question's drawer and dismiss it again.
 *
 * A modal owns focus while it is up, so anything that means to reach a control
 * beneath it has to close it first — and dismissing one answers nothing, so the
 * question is still waiting afterwards and can be opened again.
 */
function* dismissQuestion(page: ReplPage): Operation<void> {
  yield* openQuestion(page);
  yield* page.key("Escape");
  yield* page.until("the question's drawer closing", (frame) => !formShowing(frame));
}

/** Scroll the transcript's own reading window until it shows this text. */
function* scrollReadingTo(page: ReplPage, text: string): Operation<void> {
  yield* scrollUntil(
    page,
    { window: "reading", control: "reading:later", toward: "more" },
    (frame) => shows(frame, text),
    60,
  );
}

/**
 * Every execution the repository holds, by identifier.
 *
 * By identifier rather than by filename, because an execution's entry history
 * now lives in one of two places: an older single-file one is
 * `<execution>.jsonl`, and a published pair keeps its entries inside
 * `v1/<execution>/`. The identifier is the thing these cases are actually
 * about — it is what a location names — so the layout is resolved by
 * `historyPath` below rather than spelled out at forty call sites.
 */
function* histories(root: string): Operation<string[]> {
  const directory = join(root, "xmd", "repl");
  const found: string[] = [];
  for (const name of yield* until(readdir(directory))) {
    if (name.endsWith(".jsonl")) {
      found.push(name.slice(0, -".jsonl".length));
      continue;
    }
    if (name !== PAIRED_DIRECTORY) {
      continue;
    }
    for (const execution of yield* until(readdir(join(directory, name)))) {
      found.push(execution);
    }
  }
  return found.toSorted();
}

/** Where one execution's entry history is, in whichever shape holds it. */
function* historyPath(root: string, execution: string): Operation<string> {
  const directory = join(root, "xmd", "repl");
  const paired = join(directory, PAIRED_DIRECTORY, execution, ENTRIES_FILE);
  return (yield* until(
    stat(paired).then(
      () => true,
      () => false,
    ),
  ))
    ? paired
    : join(directory, `${execution}.jsonl`);
}

/** One history file's lines, projected as the model reads them. */
function* projectionOf(root: string, execution: string): Operation<ReplModel> {
  const projected = projectRepl(
    (yield* records(root, execution)).map((line) => {
      const parsed = parseDurableEvent(line);
      if (!parsed.ok) {
        throw parsed.error;
      }
      return parsed.value;
    }),
  );
  if (!projected.ok) {
    throw projected.error;
  }
  return projected.value;
}

/** One history file's lines, without the trailing empty one. */
function* records(root: string, execution: string): Operation<string[]> {
  const text = yield* until(readFile(yield* historyPath(root, execution), "utf8"));
  return text.split("\n").filter((line) => line.length > 0);
}

/** Wait until the history holds an elicit record. */
function* untilRecorded(
  root: string,
  execution: string,
  what: string,
  word: string,
): Operation<void> {
  yield* awaitedFact(what, function* () {
    return (yield* records(root, execution)).some((line) => line.includes(word));
  });
}

/**
 * Type one source into the draft and admit it as an entry.
 *
 * What says the entry exists is the History rail gaining an entry it did not
 * have, beside a draft that has emptied — the draft is the thing this helper
 * just put there, so both halves are about this submission and no other.
 */
function* submitted(page: ReplPage, source: string): Operation<void> {
  const before = railEntries(page.frame());
  yield* paste(page, draft(page), source);
  yield* page.key("Enter");
  yield* page.until(
    "the draft becoming an entry",
    (frame) => draft(page).text() === "" && railEntries(frame) > before,
  );
}

/** Whether the History drawer is the layer this frame shows. */
function historyOpen(frame: PageFrame): boolean {
  return (
    frame
      .area("box:drawer:layer")
      ?.rows()
      .some((line) => /^\s*History\b/.test(line)) ?? false
  );
}

/** The layer's History positions, as the keys they are placed under and the words they say. */
function positions(frame: PageFrame): { readonly key: string; readonly text: string }[] {
  const layer = frame.area("box:drawer:layer");
  return (layer?.controls() ?? [])
    .filter((key) => key.startsWith("drawer:marker:"))
    .map((key) => ({ key, text: (frame.control(key)?.text ?? "").replace(/^>\s+/, "") }));
}

/** The key of the History position whose own cells say this. */
function markerKey(page: ReplPage, words: string): string {
  const found = positions(page.frame()).find((one) => one.text.includes(words));
  if (found === undefined) {
    throw new Error(`no History position says ${JSON.stringify(words)}. ${page.describe()}`);
  }
  return found.key;
}

/** More than any label this REPL puts in a drawer, and less than any box. */
const LABEL_ROOM = 48;

/**
 * Real time for an assertion that something did not happen.
 *
 * A held command that has not moved on changes nothing on the screen and
 * publishes no event: there is nothing to wait for, so the assertion is given a
 * window in which to be wrong.
 */
function* lingering(): Operation<void> {
  yield* sleep(100);
}

/** The key of the placed control, under this prefix, whose own cells say this. */
function controlWith(page: ReplPage, prefix: string, words: string): string {
  const frame = page.frame();
  const found = frame
    .keys()
    .find((key) => key.startsWith(prefix) && frame.control(key)?.text.includes(words));
  if (found === undefined) {
    throw new Error(`no ${prefix} control says ${JSON.stringify(words)}. ${page.describe()}`);
  }
  return found;
}

/**
 * Every row the open drawer can show, gathered by scrolling its own window.
 *
 * Through `[\u2193 later]`, the way a person reaches the rest of a long record:
 * activating it moves the window by a row, and what the window holds is what is
 * mounted. Stops when the window cannot move further.
 */
function* drawerContent(
  page: ReplPage,
): Operation<{ readonly first: string[]; readonly reached: string[] }> {
  const rows = (): string[] => drawerRows(page.frame());
  const first = rows();
  const seen = [...first];
  yield* page.focus("drawer:scroll:down");
  for (let press = 0; press < 120; press += 1) {
    const window = page.frame().windows.get("drawer");
    if (window === undefined || !window.more) {
      break;
    }
    yield* page.key("Enter");
    yield* page.until(
      "the drawer's window moving",
      (frame) => frame.windows.get("drawer")?.from !== window.from,
    );
    for (const row of rows()) {
      if (!seen.includes(row)) {
        seen.push(row);
      }
    }
  }
  return { first, reached: seen };
}

/** The rows the open drawer's own window holds, without the cue its focused row wears. */
function drawerRows(frame: PageFrame): string[] {
  return (frame.area("box:drawer:viewport")?.rows() ?? [])
    .map((line) => line.replace(/^\s*>\s+/, "").trim())
    .filter((line) => line !== "");
}
/**
 * One entry that publishes a value and then holds at a question.
 *
 * The hold is what makes "a draft typed while an entry runs" a fact rather than
 * a race: an ordinary document settles whenever it settles, and a question is
 * the one place one stops and waits for somebody.
 */
const JOURNEY_ONE = [
  "```js eval",
  'const token = "alpha";',
  "const schema = {",
  '  type: "object",',
  '  properties: { decision: { type: "string", enum: ["go"] } },',
  '  required: ["decision"],',
  "  additionalProperties: false,",
  "};",
  "```",
  "",
  '<Elicit schema={schema} as="answer">Ready?</Elicit>',
  "",
  "One: {token}/{answer.decision}",
  "",
].join("\n");

/** One entry that reads what the first published, renders it, and then fails. */
const JOURNEY_TWO = [
  "```js eval",
  "const seen = `${token}-two`;",
  "```",
  "",
  "Two: {seen}",
  "",
  "```js eval",
  "const lost = nothingDeclaredAnywhere;",
  "```",
  "",
].join("\n");

/** One entry that follows the failure and still reads the first entry's value. */
const JOURNEY_THREE = [
  "```js eval",
  "const after = `${token}-three`;",
  "```",
  "",
  "Three: {after}",
  "",
].join("\n");

/**
 * One entry whose two children run together: one asks, the other fails.
 *
 * The failing child waits on a fetch the test holds, so the question is open and
 * its drawer is mounted before anything fails — which is the only arrangement in
 * which a *mounted* drawer can be observed going away.
 */
const SIBLING_FAILS = [
  "```js eval",
  "const schema = {",
  '  type: "object",',
  '  properties: { decision: { type: "string", enum: ["go"] } },',
  '  required: ["decision"],',
  "  additionalProperties: false,",
  "};",
  "```",
  "",
  "<All>",
  "<Spawn>",
  '<Elicit schema={schema} as="answer">Ready?</Elicit>',
  "</Spawn>",
  "<Spawn>",
  "```js eval",
  'yield* fetch("https://held.invalid/sibling");',
  "```",
  "</Spawn>",
  "</All>",
  "",
].join("\n");

/** One short question, so the whole drawer — its control included — is drawn. */
const SHORT_QUESTION = [
  "```js eval",
  "const schema = {",
  '  type: "object",',
  '  properties: { decision: { type: "string", enum: ["go"] } },',
  '  required: ["decision"],',
  "  additionalProperties: false,",
  "};",
  "```",
  "",
  '<Elicit schema={schema} as="answer">Go?</Elicit>',
  "",
  "Decision: {answer.decision}",
  "",
].join("\n");

/** One entry whose question is far wider than the narrowest supported frame. */
const LONG_QUESTION = [
  "```js eval",
  "const schema = {",
  '  type: "object",',
  '  properties: { decision: { type: "string", enum: ["go"] } },',
  '  required: ["decision"],',
  "  additionalProperties: false,",
  "};",
  "```",
  "",
  '<Elicit schema={schema} as="answer">' +
    "Would you like to approve the plan that was drafted for this execution, " +
    "including every file it proposes to write and every command it proposes to run?" +
    "</Elicit>",
  "",
  "Decision: {answer.decision}",
  "",
].join("\n");

/** Two entries, the second reading what the first published, with no question. */
const COLD_ONE = ["```js eval", 'const token = "alpha";', "```", "", "One: {token}", ""].join("\n");

const COLD_TWO = [
  "```js eval",
  "const carried = `${token}-again`;",
  "```",
  "",
  "Two: {carried}",
  "",
].join("\n");

/** An entry that prints, publishes a binding, and then waits on a question. */
const STOPPED_ENTRY = [
  "```js eval",
  'const token = "held";',
  'output("printed before the question");',
  "const schema = {",
  '  type: "object",',
  '  properties: { decision: { type: "string", enum: ["go"] } },',
  '  required: ["decision"],',
  "  additionalProperties: false,",
  "};",
  "```",
  "",
  '<Elicit schema={schema} as="answer">Go?</Elicit>',
  "",
  "One: {answer.decision}",
  "",
].join("\n");

/**
 * The second entry's source, which invokes a component this fixture directory
 * already supplies — so the execution retains a scope beneath an entry.
 */
const SCOPED_TWO = [COLD_TWO, '<Checklist title="Resize scope" steps={2} />', ""].join("\n");

/** The component occurrence this reading is of, as the screen names it. */
const SCOPE_NAME = "Checklist";

/** Its own catalog row, drawn beneath the entry that admitted it. */
const CATALOG_SCOPE = `component ${SCOPE_NAME}`;

/**
 * The retained position this journey freezes at.
 *
 * The component's own admission rather than the entry's: a prefix taken at
 * entry 2's admission predates the component, and a reading of a scope the
 * prefix does not hold is one resolution refuses.
 */
const CHECKPOINT = "Component admitted";

/** The draft this reading carries across every size, with a space in it. */
const DRAFTED = "keep this draft";

/** The Sidekick message the same reading carries, which no location records. */
const ASKED = "and what changed";

/**
 * Entry 2's catalog row, as the position being read says it.
 *
 * At entry 2's own admission nothing of entry 2 has settled, so its outcome row
 * is the unfinished one — which is a fact about the position rather than about
 * the entry, and is why this label is not the settled one.
 */
const READING = "2. [unfinished] entry-2";

/** Two more sources, so there are more positions than a narrow drawer holds. */
const COLD_THREE = [
  "```js eval",
  "const onward = `${carried}-again`;",
  "```",
  "",
  "Three: {onward}",
  "",
].join("\n");

const COLD_FOUR = [
  "```js eval",
  "const onto = `${onward}-once-more`;",
  "```",
  "",
  "Four: {onto}",
  "",
].join("\n");

/**
 * What each category of position is called, written out here on purpose.
 *
 * A second opinion about the wording. Reading it from the product would make
 * the comparison below say only that one function agrees with itself, and the
 * requirement is that the drawer offers *these* words — a category and an order,
 * with nothing of the payload in them.
 */
const CATEGORIES: Readonly<Record<string, string>> = Object.freeze({
  entry: "Entry %E admitted",
  scope: "Component admitted",
  binding: "Bindings recorded",
  generated: "Generated XMD admitted",
  elicit: "Answer recorded",
  agent: "Agent turn recorded",
  terminal: "Entry outcome recorded",
});

/**
 * Every row this model's positions should put in the drawer, in order.
 *
 * Built from the projected checkpoints' kinds alone: the ordinal is the position
 * in the recorded order and the entry number is how many entry admissions have
 * been passed, both counted here rather than read out of the thing under test.
 */
function expectedRows(model: ReplModel): string[] {
  let entry = 0;
  return model.checkpoints.map((checkpoint, index) => {
    if (checkpoint.kind === "entry") {
      entry += 1;
    }
    const words = CATEGORIES[checkpoint.kind];
    if (words === undefined) {
      throw new Error(`no category is written down for ${checkpoint.kind}`);
    }
    return `${index + 1} · ${words.replace("%E", String(entry))}`;
  });
}

/** An entry of this many lines, for measuring what an interaction costs beside it. */
function longEntry(lines: number): string {
  return `${Array.from({ length: lines }, (_, at) =>
    at % 4 === 3
      ? ""
      : `<Json value={{ ordinal: ${at}, note: "line ${at} of a long entry" }} as="n${at}" />`,
  ).join("\n")}\n`;
}

/** One entry that does not finish the instant it is admitted. */
const SLOW_ENTRY = ["```ts eval", "yield* sleep(800)", "```", ""].join("\n");

/** The catalog rows that wear the mark of the entry being read. */
function readEntries(frame: PageFrame): string[] {
  return (frame.area("box:drawer:layer")?.controls() ?? []).filter(
    (key) => key.startsWith("entry:") && selectionMarked(frame.control(key)?.text),
  );
}

/** Close the input and wait for the command to return, whatever it returned. */
function* leave(page: ReplPage): Operation<Result<ReplOutcome>> {
  page.repl.terminal.end();
  return yield* outcomeOf(page);
}

describe("REPL journey: one entry, from raw bytes", () => {
  it("J1: pasting the reference entry puts all of it in the draft and the location", function* () {
    const source = yield* referenceSource();
    const { page, root } = yield* mountJourney();
    const files = yield* histories(root);

    // Pasted, as a terminal delivers a paste: one burst of bytes carrying
    // every line, including the newlines between them. The scanner hands over
    // 128 events per call and buffers the rest, so proving the whole document
    // arrived is proving the host drained it.
    const before = page.repl.terminal.presented.length;
    yield* paste(page, draft(page), source);

    // One burst is one frame, not one frame per character.
    expect(page.repl.terminal.presented.length - before).toBeLessThan(4);
    // The field is a block now, and what it shows is the end of the value —
    // that is where somebody is typing. So the rows on the screen are the
    // source's own last rows, in order, with the authored blank between them
    // kept as a row. The whole of it, byte for byte, is asserted against the
    // decoded location below; this is what a reader can see of it.
    expect(draftShows(page, source)).toBe(true);
    const tail = source.split("\n").filter((line) => line.trim() !== "");
    expect(
      draft(page)
        .text()
        .trimEnd()
        .endsWith(tail[tail.length - 1] ?? ""),
    ).toBe(true);
    expect(source.includes("\n\n")).toBe(true);
    // Nothing durable yet: a draft is this process's, and the file is empty.
    expect(yield* records(root, files[0])).toEqual([]);

    yield* finish(page);

    // The canonical location carries the draft exactly — every line, every
    // character — which is what makes a draft reopenable before it is durable.
    const decoded = decodeLocation(exitRoute(page).location());
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.value.draft).toBe(source);
      expect(decoded.value.surface).toBe("entries");
      expect(decoded.value.at).toBeUndefined();
    }
  });

  it("J1: submitting admits exactly that source, and the run settles", function* () {
    const source = yield* referenceSource();

    const terminal = yield* scoped(function* (): Operation<Terminal> {
      const { page, root } = yield* mountJourney();
      const files = yield* histories(root);

      yield* paste(page, draft(page), source);
      yield* page.key("Enter");
      yield* page.until("the entry asking its question", asked);

      const lines = yield* records(root, files[0]);
      expect(lines.length).toBeGreaterThan(0);
      // Every line is an ordinary durable record. There is no REPL record type,
      // no manifest and no cache: the file and the URL are the whole state.
      for (const line of lines) {
        const parsed: unknown = JSON.parse(line);
        expect(typeof parsed).toBe("object");
        if (typeof parsed === "object" && parsed !== null && "type" in parsed) {
          expect(["yield", "close"]).toContain(parsed.type);
        }
      }

      // The entry is admitted and it has not settled, and the question it
      // reaches is being asked.
      //
      // Read from the history rather than from the screen. The footer used to
      // report admission, because the draft was replaced by a notice once an
      // entry existed; a draft is now execution-wide and goes on being typed
      // while an entry runs (#827 Slice C), so what says an entry exists is its
      // catalog row — and that row is in the sidebar, behind the open drawer.
      const admittedModel = yield* projectionOf(root, files[0]);
      expect(admittedModel.entries.map((entry) => entry.key)).toEqual(["entry-1"]);
      expect(admittedModel.entries[0]?.source).toBe(source);
      expect(admittedModel.entries[0]?.settled).toBe(false);
      expect(asked(page.frame())).toBe(true);

      yield* finish(page);
      return page.repl.terminal;
    });

    expect(terminal.resets).toBe(1);
    expect(terminal.readers).toBe(0);
    expect(terminal.listeners).toBe(0);
  });

  it("J1: the question is answered through the terminal, and the answer settles", function* () {
    const source = yield* referenceSource();

    const terminal = yield* scoped(function* (): Operation<Terminal> {
      const { page, root } = yield* mountJourney();
      const files = yield* histories(root);

      yield* paste(page, draft(page), source);
      yield* page.key("Enter");
      yield* page.until("the entry asking its question", asked);

      // The question announces itself and opens nothing. Activating that
      // announcement is what opens the drawer, and the drawer then shows the
      // retained schema as a form: one field, its choices.
      expect(shows(page.frame(), "decision: approve | decline")).toBe(false);
      yield* openQuestion(page);
      expect(shows(page.frame(), "decision: approve | decline")).toBe(true);

      // Typed, as a person types it, into the field the drawer focused.
      yield* form(page).value("decision").type("approve");
      yield* page.key("Enter");

      // The answer is recorded as an ordinary elicit event, and what the document
      // rendered after it changed because of the stored answer.
      yield* untilRecorded(root, files[0], "the answer being recorded", "elicit");
      // Reached through the reading's own window, for the accepted body gutter:
      // the same retained output pays out over more rows in an inset column.
      yield* scrollReadingTo(page, "Decision: approve");
      expect(shows(page.frame(), "Decision: approve")).toBe(true);
      // Settled: the root closed, so the answer is in the history and the
      // entry's catalog row carries the outcome it closed with.
      yield* page.until("the entry completing", (frame) => shows(frame, "✓ COMPLETED"));

      // The Transcript is still there and still explicitly empty. One list
      // across both owners since the single-list correction, so an execution
      // that has done no agent work says so once — the two owners keep their
      // separate domains, and what changed is how the screen reads them.
      expect(shows(page.frame(), "TRANSCRIPT")).toBe(true);
      expect(shows(page.frame(), "(none retained)")).toBe(true);

      yield* finish(page);
      expect(exitRoute(page).location()).toBeDefined();
      return page.repl.terminal;
    });

    expect(terminal.resets).toBe(1);
  });

  it("J1: a second process reconstructs the view from the URL and the journal alone", function* () {
    const source = yield* referenceSource();
    const retained = yield* useTemporary("xmd-repl-journey-");

    // One complete journey, then the process is over.
    const { files, first } = yield* scoped(function* () {
      const { page } = yield* mountJourney({ root: retained });
      const named = yield* histories(retained);

      yield* paste(page, draft(page), source);
      yield* page.key("Enter");
      // The question announces itself; activating that announcement is what opens
      // the form the answer is typed into.
      yield* openQuestion(page);
      yield* form(page).value("decision").type("approve");
      yield* page.key("Enter");
      yield* entrySettles(page, 1, "ok");

      yield* finish(page);
      return { files: named, first: page.repl.terminal };
    });
    // Halted completely: no session, no provider, no observer, no view cache.
    expect(first.resets).toBe(1);
    expect(first.readers).toBe(0);

    const execution = files[0].replace(/\.jsonl$/, "");
    const lines = yield* records(retained, files[0]);

    // A location that selects something meaningful: a structural scope inside the
    // entry, a historical position, and a recorded drawer.
    const projected = projectRepl(
      lines.map((line) => {
        const parsed = parseDurableEvent(line);
        if (!parsed.ok) {
          throw parsed.error;
        }
        return parsed.value;
      }),
    );
    if (!projected.ok) {
      throw projected.error;
    }
    const entry = projected.value.entries[0]?.scope;
    expect(entry).toBeDefined();
    const nested = entry?.scopes[0];
    expect(nested).toBeDefined();
    const binding = entry?.bindings[0];
    expect(binding).toBeDefined();
    const marker = projected.value.checkpoints[projected.value.checkpoints.length - 1]?.marker;
    expect(marker).toBeDefined();
    if (
      entry === undefined ||
      nested === undefined ||
      binding === undefined ||
      marker === undefined
    ) {
      throw new Error("the retained history holds an entry, a nested scope, a binding and markers");
    }

    // A drawer names something inside the scope the location selects, which is
    // why this selects the entry: the binding is the entry's, and a location that
    // opened it beside a nested scope would be describing two different places.
    const location = encodeLocation({
      execution,
      surface: "entries",
      scopes: [entry.key],
      drawers: [{ kind: "binding", name: binding.name }],
      at: marker,
      inspect: true,
      draft: undefined,
      session: undefined,
      view: undefined,
      right: undefined,
      sidekick: undefined,
    });

    // A fresh host: a new terminal, a new repository handle, and nothing carried
    // over but that URL and the file it names.
    const { performed, second } = yield* scoped(function* () {
      const hosted = yield* useJourneyHost({ root: retained, reopening: true });
      const counted = yield* countPerformed();
      const page = yield* startJourney(hosted, { location });

      // The same topology, the same binding value, the same transcript and the
      // same recorded answer — read from the file, not re-run.
      // The drawer the location named is open on the retained value — named as
      // that binding, and holding the value the file retained for it.
      yield* page.until("the retained binding's drawer", (frame) => shows(frame, "[close]"));
      expect(shows(page.frame(), "[close]")).toBe(true);
      expect(shows(page.frame(), `Binding · ${binding.name}`)).toBe(true);
      expect(shows(page.frame(), '"title": "Ship the REPL"')).toBe(true);

      // Out from under the drawer first: a modal covers what it is in front of, so
      // the columns beneath it are read once it is closed.
      yield* page.key("Escape");
      yield* page.until("the drawer closing", (frame) => !shows(frame, "[close]"));

      // The same topology: the entry, and the nested component occurrence
      // beneath it, at the exact keys the first process recorded. Asked of the
      // catalog, which is where this screen keeps them — opened explicitly,
      // read, and put away again, because a drawer left open would cover the
      // reading the rows below are about.
      yield* openCatalog(page);
      expect(shows(page.frame(), entry.name)).toBe(true);
      expect(shows(page.frame(), nested.name)).toBe(true);
      yield* closeCatalog(page);
      // And closing chose nothing: the reading is the one the location named.
      expect(selectedEntry(page.frame())).toBeDefined();
      // The same transcript, including the answer the first process gave and the
      // output that answer produced. Reached through the reading's own window:
      // the accepted row of space above each column heading costs this column a
      // row, so the last row of a full reading is a press away rather than
      // drawn. The string is the whole of what was retained either way, and
      // scrolling moved the viewport and wrote nothing.
      yield* scrollReadingTo(page, "Decision: approve");
      expect(shows(page.frame(), "Decision: approve")).toBe(true);

      yield* finish(page);
      return { performed: counted, second: page.repl.terminal };
    });

    // No completed work was performed again: no component source was read, no
    // eval block was compiled, and nobody was asked anything.
    expect(performed.reads).toEqual([]);
    expect(performed.compiles).toBe(0);
    expect(performed.asked).toBe(0);
    // And nothing was appended: the file is exactly what the first process left.
    expect(yield* records(retained, files[0])).toEqual(lines);
    expect(second.resets).toBe(1);
  });

  it("J1: starting with no location creates one execution and focuses an empty draft", function* () {
    const terminal = yield* scoped(function* (): Operation<Terminal> {
      const { page, root } = yield* mountJourney();

      // One retained execution, created exclusively, and named opaquely.
      const files = yield* histories(root);
      expect(files).toHaveLength(1);
      const execution = files[0].replace(/\.jsonl$/, "");
      expect(execution).toMatch(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
      // Nothing is in it yet: no entry, so no record.
      expect(yield* records(root, files[0])).toEqual([]);

      // The screen says where it is, what it holds and what it is waiting for.
      // The Transcript is one list across both owners, so an execution that
      // has done nothing says so once rather than twice.
      expect(draftFocused(page.frame())).toBe(true);
      expect(shows(page.frame(), "TRANSCRIPT")).toBe(true);
      expect(shows(page.frame(), "(none retained)")).toBe(true);
      expect(shows(page.frame(), "Entries")).toBe(true);
      expect(shows(page.frame(), "No entry yet")).toBe(true);

      page.repl.terminal.end();
      const outcome = yield* returned(page);
      expect(outcome.location).toBe(`xmd://repl/${execution}/entries`);
      expect(outcome.refusal).toBeUndefined();
      return page.repl.terminal;
    });

    // And it gave the terminal back.
    expect(terminal.resets).toBe(1);
    expect(terminal.readers).toBe(0);
    expect(terminal.listeners).toBe(0);
    expect(terminal.raw[terminal.raw.length - 1]).toBe(false);
  });
});

describe("REPL journey: leaving", () => {
  const DRAFT = "# queued behind an interrupt";

  it("J1: Control-C ends the command and prints the location", function* () {
    const terminal = yield* scoped(function* (): Operation<Terminal> {
      const { page, root } = yield* mountJourney();
      const files = yield* histories(root);
      const execution = files[0].replace(/\.jsonl$/, "");

      // The interrupt and nothing else. The stream is deliberately left open:
      // closing it would end the command by EOF and prove that instead.
      yield* page.type("\x03");
      const outcome = yield* returned(page);

      // The same ending every other way of leaving produces, location included.
      expect(outcome.location).toBe(`xmd://repl/${execution}/entries`);
      expect(outcome.refusal).toBeUndefined();
      return page.repl.terminal;
    });

    // And it gave the terminal back, exactly once.
    expect(terminal.resets).toBe(1);
    expect(terminal.readers).toBe(0);
    expect(terminal.listeners).toBe(0);
    expect(terminal.raw[terminal.raw.length - 1]).toBe(false);
  });

  it("J1: Control-C leaves a refusal, and it is still a refusal", function* () {
    const terminal = yield* scoped(function* (): Operation<Terminal> {
      const hosted = yield* useJourneyHost();

      // A file that is not a projectable history, so the command mounts the
      // refusal screen instead of a session.
      const directory = join(hosted.root, "xmd", "repl");
      yield* until(mkdir(directory, { recursive: true }));
      yield* until(writeFile(join(directory, "broken.jsonl"), "{not a record}\n"));

      const page = yield* startJourney(hosted, { location: "xmd://repl/broken/entries" });
      expect(says(page.frame(), "box:root", "cannot read")).toBe(true);

      // The interrupt, with the stream left open: the refusal screen is its own
      // loop, so a key that ends the main loop proves nothing about this one.
      yield* page.type("\x03");
      const outcome = yield* outcomeOf(page);

      // Left, and still refused: how a person leaves a location this command
      // cannot show does not turn it into one it could.
      expect(outcome.ok).toBe(false);
      return page.repl.terminal;
    });

    expect(terminal.resets).toBe(1);
    expect(terminal.readers).toBe(0);
  });

  it("J1: input queued behind Control-C starts nothing and appends nothing", function* () {
    const terminal = yield* scoped(function* (): Operation<Terminal> {
      const { page, root } = yield* mountJourney();

      yield* paste(page, draft(page), DRAFT);

      // One chunk carrying the interrupt and a submission behind it, which is
      // what a terminal delivers when both were typed before either was read.
      // The Enter is input that arrived before leaving was decided, so it must
      // reach nothing: a batch is not a licence to act after the decision.
      yield* page.type("\x03\r");
      const outcome = yield* returned(page);

      // Nothing was submitted, so the one history file this execution created
      // holds no record at all.
      const files = yield* histories(root);
      expect(files).toHaveLength(1);
      expect(yield* records(root, files[0])).toEqual([]);

      // And what was being typed survived, because the location is read off the
      // state as it stood when leaving was decided.
      const decoded = decodeLocation(outcome.location);
      expect(decoded.ok).toBe(true);
      if (decoded.ok) {
        expect(decoded.value.draft).toBe(DRAFT);
      }
      return page.repl.terminal;
    });

    // Teardown still happens exactly once, on the way out of one decision.
    expect(terminal.resets).toBe(1);
    expect(terminal.readers).toBe(0);
    expect(terminal.listeners).toBe(0);
    expect(terminal.raw[terminal.raw.length - 1]).toBe(false);
  });

  it("J1: a cold reopen restores the selection, the history position and the draft", function* () {
    const root = yield* useTemporary("xmd-repl-journey-");

    // One process that admits an entry and ends, leaving only the file behind.
    const execution = yield* scoped(function* (): Operation<string> {
      const { page } = yield* mountJourney({ root });
      yield* submitted(page, "# cold reopen");
      yield* entrySettles(page, 1, "ok");
      yield* finish(page);
      return exitRoute(page).route().execution;
    });

    const files = yield* histories(root);
    expect(files).toHaveLength(1);
    const path = yield* historyPath(root, files[0]);
    const before = yield* until(readFile(path, "utf8"));

    // The three route members this row is about, read out of the file the first
    // process left rather than invented: an entry to select, and a position in
    // its history to be reading at.
    const projected = projectRepl(
      (yield* records(root, files[0])).map((line) => {
        const parsed = parseDurableEvent(line);
        if (!parsed.ok) {
          throw parsed.error;
        }
        return parsed.value;
      }),
    );
    if (!projected.ok) {
      throw projected.error;
    }
    const entry = projected.value.entries[0]?.scope;
    const marker = projected.value.checkpoints[projected.value.checkpoints.length - 1]?.marker;
    if (entry === undefined || marker === undefined) {
      throw new Error("the retained history holds an entry and at least one position");
    }

    const location = encodeLocation({
      execution,
      surface: "entries",
      scopes: [entry.key],
      drawers: [],
      at: marker,
      inspect: false,
      draft: "# what comes next",
      session: undefined,
      view: undefined,
      right: undefined,
      sidekick: undefined,
    });

    // A fresh host carrying nothing but that location and the file it names,
    // pointed at the file the first process left and structurally unable to mint
    // an identifier or create one: a reopen that did either would be starting an
    // execution rather than reading one.
    const reopened = yield* scoped(function* (): Operation<Terminal> {
      const { page } = yield* mountJourney({ root, location, reopening: true });

      // On the screen, not merely in the route: the entry the location named is
      // the one being read, its own catalog row carries the selected marker,
      // and what was being typed is in the draft.
      //
      // At a shared width there is no routed-surface bar — three columns are
      // drawn at once, and that bar belongs to the narrow frame that routes one
      // outlet. The breadcrumb is what states which entry is being read here,
      // the catalog is where the marked row is, and the decoded route is the
      // exact surface. The location equality below covers all three again.
      const decoded = decodeLocation(location);
      expect(decoded.ok).toBe(true);
      if (decoded.ok) {
        expect(decoded.value.surface).toBe("entries");
      }
      expect(selectedEntry(page.frame())).toBeDefined();
      yield* openCatalog(page);
      expect(readEntries(page.frame()).length).toBeGreaterThan(0);
      yield* closeCatalog(page);
      expect(draft(page).text()).toBe("# what comes next");

      yield* finish(page);

      // And it ends where it was opened. One equality covers all three members,
      // because a location that lost the selection, the position or the draft
      // could not spell itself back the same way.
      expect(exitRoute(page).location()).toBe(location);
      return page.repl.terminal;
    });

    // A cold process reads; it does not write.
    expect(yield* until(readFile(path, "utf8"))).toBe(before);
    expect(reopened.resets).toBe(1);
  });

  it("J1: no other chord ends it, so what leaves is the key and not the modifier", function* () {
    const { page } = yield* mountJourney();

    // Alt-a, Control-H and F5: still dropped whole. Without this the test
    // above would pass just as well had every chord been made to leave.
    yield* page.type("\x1ba");
    yield* page.type("\x08");
    yield* page.type("\x1b[15~");
    // Input is read in order, so the key that shows is read after the three
    // chords were: the command is still here, and nothing of them was typed.
    yield* draft(page).type("z");
    expect(page.repl.outcome()).toBeUndefined();
    expect(draft(page).text()).toBe("z");

    yield* finish(page);
    expect(page.repl.outcome()?.ok).toBe(true);
  });
});

/**
 * The breadcrumb's ancestors are controls, and each goes where it says (#971 B3).
 *
 * The trail says where the reading is, and every name in it but the last is a
 * way back out to that name. So the entry's own name, with a nested scope
 * selected under it, is a control: activating it leaves the reading at the
 * entry and the trail with one name in it, and the location the command
 * publishes on its way out says the same thing — which is what makes this a
 * fact about the route rather than about a row.
 */
describe("REPL journey: the breadcrumb goes back the way it came", () => {
  it("B3: an ancestor in the trail is a control, and it selects its own prefix", function* () {
    const source = yield* referenceSource();
    const standing = yield* scoped(function* (): Operation<string> {
      const { page } = yield* mountJourney();

      yield* submitted(page, source);
      yield* dismissQuestion(page);

      // A nested scope, chosen in the catalog: that is what gives this trail an
      // ancestor to go back to. With only an entry selected the trail is one
      // name, and one name is where the reading already is.
      yield* openCatalog(page);
      yield* page.focus("scope:entry-1/Checklist-1");
      yield* page.key("Enter");
      yield* page.until("the catalog closing behind the choice", (frame) => !catalogOpen(frame));
      yield* page.until("the Checklist scope being read", (frame) => shows(frame, "Checklist"));

      // The trail now names both, in the order they were selected, and the
      // outer one is a control a person can reach by Tab.
      const trail = crumbTrail(page.frame());
      expect(trail).toContain("Entry 1");
      expect(trail).toContain("Checklist");
      expect(trail.indexOf("Entry 1")).toBeLessThan(trail.indexOf("Checklist"));
      yield* page.focus("work:crumb:0");
      expect(page.frame().focused).toBe("work:crumb:0");
      expect(page.frame().control("work:crumb:0")?.text).toContain("Entry 1");

      // Activated, it selects its own prefix of the path: the reading is the
      // entry, and the scope beneath it is no longer selected.
      yield* page.key("Enter");
      yield* page.until(
        "the reading coming back to the entry",
        (frame) => !crumbTrail(frame).includes("Checklist"),
      );
      expect(crumbTrail(page.frame())).toContain("Entry 1");
      // And it is the entry that is being read, not nothing: the trail still
      // names it and the catalog still marks its row.
      yield* openCatalog(page);
      expect(selectionMarked(page.frame().control("entry:entry-1")?.text)).toBe(true);
      yield* closeCatalog(page);

      yield* finish(page);
      return exitRoute(page).location();
    });

    // The route the command published says the same: one scope, the entry's.
    const stood = decodeLocation(standing);
    expect(stood.ok).toBe(true);
    if (stood.ok) {
      expect(stood.value.scopes).toHaveLength(1);
    }
  });
});

describe("REPL journey: what it refuses, and what it leaves alone", () => {
  it("J1: an invalid navigation leaves the standing route, tree, focus and targets", function* () {
    const source = yield* referenceSource();
    yield* scoped(function* (): Operation<void> {
      const { page, root } = yield* mountJourney();
      const files = yield* histories(root);

      yield* submitted(page, source);
      yield* dismissQuestion(page);

      // A standing, meaningful selection, reached through the product: the
      // nested component occurrence, which exists only after the run admitted
      // it. Its row is in the catalog, so the catalog is opened to reach it —
      // and choosing it closes the catalog behind the choice, which is what
      // leaves the reading on screen.
      yield* openCatalog(page);
      yield* page.focus("scope:entry-1/Checklist-1");
      yield* page.key("Enter");
      yield* page.until("the catalog closing behind the choice", (frame) => !catalogOpen(frame));
      // Selected, and visibly so: the breadcrumb of the reading on screen names
      // that scope.
      yield* page.until("the Checklist scope being read", (frame) => shows(frame, "Checklist"));
      const before = page.frame().rows;
      const admitted = yield* records(root, files[0]);

      // Now a history position from *before* that scope was admitted. Both
      // controls are ordinary mounted controls, and the combination is a view that
      // cannot exist: the route selects a scope the prefix does not hold.
      yield* page.focus("footer:history");
      yield* page.key("Enter");
      yield* page.until("the History drawer", (frame) => historyOpen(frame));
      const position = markerKey(page, "Entry 1 admitted");
      yield* page.focus(position);
      // What holds focus at the moment of the refused navigation, so the claim
      // afterwards is about the same control rather than about there being one.
      expect(page.frame().focused).toBe(position);
      // And where its close control is, recorded now.
      const closeAt = page.frame().control("drawer:close")?.bounds;
      yield* page.key("Enter");
      yield* page.until("the refusal saying why", (frame) => guidanceRow(frame).includes("!"));

      // The route that stands is the one that worked. The drawer it was asked
      // from is still open — the navigation did not happen, so nothing it would
      // have changed changed — and the file is untouched.
      // The drawer it was asked from is still open, and no frozen position was
      // taken: a refused navigation changes nothing it would have changed.
      expect(shows(page.frame(), "History")).toBe(true);
      expect(historical(page.frame())).toBe(false);
      expect(yield* records(root, files[0])).toEqual(admitted);
      // And the screen says why, which is the only difference from before.
      expect(shows(page.frame(), "!")).toBe(true);

      // The same control still holds focus, in the same place.
      expect(page.frame().focused).toBe(position);
      // And the same pointer target is still the same reachable node: the exact
      // cells recorded *before* the refusal are still where the control is, and a
      // press on it still does what it did.
      expect(closeAt).toBeDefined();
      expect(page.frame().control("drawer:close")?.bounds).toEqual(closeAt);
      yield* page.press("drawer:close");
      yield* page.until("the drawer closing", (frame) => !shows(frame, "[close]"));
      expect(before.length).toBeGreaterThan(0);

      yield* finish(page);
      // The route that stands is the one that worked: the scope the product
      // really selected, and no frozen position.
      expect(exitRoute(page).location()).toContain("/Checklist-1");
      expect(exitRoute(page).route().at).toBeUndefined();
    });
  });

  it("J1: a document that cannot be admitted leaves the draft and an empty journal", function* () {
    const terminal = yield* scoped(function* (): Operation<Terminal> {
      const { page, root } = yield* mountJourney();
      const files = yield* histories(root);

      // A component nothing supplies: refused before anything is admitted.
      yield* paste(page, draft(page), "<Nowhere />");
      yield* page.key("Enter");
      // And the refusal says so rather than the keystroke seeming to do nothing.
      yield* page.until("the refusal", (frame) => frame.rows.some((line) => line.includes("!")));

      // The journal is empty, and the draft is exactly what was typed.
      expect(yield* records(root, files[0])).toEqual([]);
      expect(shows(page.frame(), "<Nowhere />")).toBe(true);

      yield* finish(page);
      return page.repl.terminal;
    });
    expect(terminal.resets).toBe(1);
  });

  it("J1: a second entry is refused, and history does not change", function* () {
    const source = yield* referenceSource();
    yield* scoped(function* (): Operation<void> {
      const { page, root } = yield* mountJourney();
      const files = yield* histories(root);

      yield* paste(page, draft(page), source);
      yield* page.key("Enter");
      yield* page.until("the entry asking its question", asked);
      const admitted = yield* records(root, files[0]);
      expect(admitted.length).toBeGreaterThan(0);

      // The question's drawer owns focus while it is up, so typing would reach its
      // answer field rather than the draft. Dismissed first, so what follows
      // really is an attempt to submit a second entry from the draft.
      yield* dismissQuestion(page);

      yield* paste(page, draft(page), "<Json value={1} />");
      yield* page.key("Enter");
      yield* page.until("the refusal", (frame) => shows(frame, "has not finished"));

      // The submission path itself refused, history did not change, and the
      // screen says why rather than appearing to do nothing.
      //
      // Superseded: this used to assert the one-entry ceiling. That ceiling is
      // gone — what refuses here is the lifecycle, because the entry before
      // this one is still running (#827 Slice C). The draft the refusal left is
      // exactly what was typed, which is the other half of the contract.
      expect(yield* records(root, files[0])).toEqual(admitted);
      // A refused submission keeps what was typed, on the row a person is
      // looking at while they type it.
      expect(draft(page).text()).toContain("<Json value={1} />");

      yield* finish(page);
      // And the route it leaves still carries that draft, byte for byte.
      expect(exitRoute(page).route().draft).toBe("<Json value={1} />");
    });
  });

  it("J1: a corrupt history refuses atomically, with no append and no session", function* () {
    const terminal = yield* scoped(function* (): Operation<Terminal> {
      const hosted = yield* useJourneyHost();
      const performed = yield* countPerformed();

      // A file that is not a projectable history.
      const directory = join(hosted.root, "xmd", "repl");
      yield* until(mkdir(directory, { recursive: true }));
      const path = join(directory, "broken.jsonl");
      yield* until(writeFile(path, "{not a record}\n"));
      const before = yield* until(readFile(path, "utf8"));

      // The refusal is a screen, so it is held until the person leaves it.
      const page = yield* startJourney(hosted, { location: "xmd://repl/broken/entries" });
      // What it says, rather than a crash: the command cannot show this history.
      expect(says(page.frame(), "box:root", "cannot read")).toBe(true);
      const outcome = yield* leave(page);

      // Refused, not thrown: a location this command cannot show is an outcome.
      expect(outcome.ok).toBe(false);
      // Nothing ran, nothing was asked, and nothing was appended.
      expect(performed.reads).toEqual([]);
      expect(performed.compiles).toBe(0);
      expect(performed.asked).toBe(0);
      expect(yield* until(readFile(path, "utf8"))).toBe(before);
      return page.repl.terminal;
    });
    expect(terminal.resets).toBe(1);
    expect(terminal.readers).toBe(0);
    expect(terminal.listeners).toBe(0);
  });

  it("J1: a malformed location reaches no path, no file and no terminal", function* () {
    const { terminal, install } = recordingTerminal();
    yield* scoped(function* (): Operation<void> {
      yield* install();
      const hosted = yield* useJourneyHost();

      const ran = yield* runReplProgram({
        location: "xmd://repl//repl",
        profile: hosted.host.profile,
      });
      expect(ran.ok).toBe(false);

      // No directory was formed, no file was created, and the terminal's modes
      // were never touched.
      expect(yield* until(readdir(hosted.root))).toEqual([]);
      expect(terminal.raw).toEqual([]);
      expect(terminal.resets).toBe(0);
      expect(terminal.readers).toBe(0);
    });
  });

  it("J1: a control chord inserts nothing into the draft", function* () {
    const { page } = yield* mountJourney();

    // Alt-a, Control-H and F5: each decodes to a letter or a key this product
    // has no meaning for, and none of them is text. Control-C is deliberately
    // not among them — it ends the command, so leaving it here would depart on
    // the first byte and the three after it would never be delivered. What it
    // does instead is "REPL journey: leaving".
    yield* page.type("\x1ba");
    yield* page.type("\x08");
    yield* page.type("\x1b[15~");
    // The end of input is read after the three, so the command has taken each
    // chord by the time it returns.
    page.repl.terminal.end();
    const outcome = yield* returned(page);

    // The draft is still empty, so the canonical location carries none.
    const decoded = decodeLocation(outcome.location);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.value.draft).toBeUndefined();
    }
  });

  it("J1: a terminal below the minimum refuses, and recovers when it grows", function* () {
    const terminal = yield* scoped(function* (): Operation<Terminal> {
      const { page } = yield* mountJourney({ size: { columns: 40, rows: 10 } });

      // The one refusal with a remedy the person already has.
      expect(shows(page.frame(), "at least 72x20")).toBe(true);
      // And nothing behind it: no control was drawn, so none can be pointed at.
      expect(page.frame().keys()).toEqual([]);
      expect(shows(page.frame(), "Sessions")).toBe(false);

      const grown = yield* page.resize(WIDE);
      // Recovered without restarting anything.
      expect(shows(grown, "TRANSCRIPT")).toBe(true);

      yield* finish(page);
      return page.repl.terminal;
    });
    expect(terminal.resets).toBe(1);
  });
});

describe("REPL journey: the whole of it, from raw bytes", () => {
  it("J1: run, hold at a gate, inspect a prefix, return live, continue, answer, settle", function* () {
    const source = yield* referenceSource();
    const retained = yield* useTemporary("xmd-repl-journey-");

    const { files, liveMarkers, captured } = yield* scoped(function* () {
      const { page } = yield* mountJourney({ root: retained });
      const named = yield* histories(retained);

      // 1. The draft, as the rows it is drawn on: the last lines of what was
      // pasted. That every byte arrived is proved at admission below, against
      // the Journal — a pane this narrow cannot show it, and reading it off a
      // clipped preview would prove less than it looks.
      yield* paste(page, draft(page), source);
      expect(draftShows(page, source)).toBe(true);

      // 2. Admitted, and then held before it can reach the question.
      //
      // Pause has to be *requested* before the document gets as far as the
      // question, because the provider's outstanding request is work that keeps a
      // walk from ever becoming satisfied — a pause asked for then is a request
      // that never becomes a hold. So the submit is followed immediately by the
      // two keystrokes that reach it: no screen is read in between, and nothing
      // waits.
      // Enter activates whatever holds focus, and what holds it is the draft — so
      // the submit goes first, and Pause is reached by walking *backwards* from
      // the draft: while expansion is playing nothing is held, so Continue is not
      // mounted and Pause is the one control before the draft. All of it in one
      // burst, so nothing is read and nothing waits.
      expect(draftFocused(page.frame())).toBe(true);
      expect(draftShows(page, source)).toBe(true);
      yield* page.key("Enter");
      yield* page.type("\x1b[Z\r");

      // Exactly paused: expansion reached a gate and stopped there. `pausing` is a
      // request that has not been met, and continuing one of those continues
      // nothing.
      yield* page.until("expansion paused", (frame) => shows(frame, "[pause] paused"));

      // 3. Held: neither the file nor the screen moves.
      const heldRecords = yield* records(retained, named[0]);
      const heldIndex = page.frame().index;
      const heldRows = page.frame().rows;
      yield* lingering();
      expect(yield* records(retained, named[0])).toEqual(heldRecords);
      expect(page.frame().index).toBe(heldIndex);
      expect(page.frame().rows).toEqual(heldRows);
      // And it is still held rather than having drifted on.
      expect(shows(page.frame(), "[pause] paused")).toBe(true);
      expect(asked(page.frame())).toBe(false);

      // 4. An earlier prefix, chosen through History.
      yield* page.focus("footer:history");
      yield* page.key("Enter");
      yield* page.until("the History drawer", historyOpen);
      // The drawer is really up: it draws the positions and the way out of them.
      expect(shows(page.frame(), "[close]")).toBe(true);
      expect(shows(page.frame(), "Entry 1 admitted")).toBe(true);
      yield* page.focus(markerKey(page, "Entry 1 admitted"));
      yield* page.key("Enter");

      // Frozen at a recorded position, which the screen says by offering the way
      // back to the head — a control that exists only while one is being read.
      yield* page.until("a frozen position", historical);
      // Read only, and nothing of the present in it.
      expect(shows(page.frame(), "[pause]")).toBe(false);
      expect(page.frame().rows.some((line) => line.trim().startsWith("…"))).toBe(false);

      // 5. Back to the head, and Continue — once — releases the hold.
      yield* page.key("Escape");
      yield* page.until(
        "the drawer closing",
        (frame) => frame.area("box:drawer:layer") === undefined,
      );
      yield* page.focus("footer:live");
      yield* page.key("Enter");
      yield* page.until("the head", (frame) => !historical(frame));
      expect(asked(page.frame())).toBe(false);

      yield* page.focus("footer:continue");
      yield* page.key("Enter");
      yield* page.until("the question", asked);

      // 6. The same execution takes the typed answer and settles, once the
      // waiting announcement has been activated.
      yield* openQuestion(page);
      yield* form(page).value("decision").type("approve");
      yield* page.key("Enter");
      // Waited for in the model first and then reached on screen: the gap above
      // each column heading costs the transcript a row, so this output is one
      // press down its own window rather than drawn with the rest.
      // The screen says it in the selected work's own heading now: the
      // outcome of the entry being read, beside its breadcrumb.
      yield* page.until("the entry settling", (frame) => shows(frame, "✓ COMPLETED"));
      yield* scrollReadingTo(page, "Decision: approve");
      expect(shows(page.frame(), "Decision: approve")).toBe(true);
      expect(shows(page.frame(), "✓ COMPLETED")).toBe(true);

      // The generated fragment's source is on screen, inside the enclosure its
      // author wrote. Which text that is comes from the model rather than from a
      // guess at its wording; where it sits comes from the screen.
      //
      // Re-anchored for #881 PR 2. This used to assert that the fragment's
      // source row came above the effect row admitting it, both of which were
      // transcript records. The reading replaces that with the stronger claim:
      // the fragment is shown *where its producer was written*, between the
      // opening and closing tags the author typed.
      const settledModel = yield* projectionOf(retained, named[0]);
      const at = settledModel.transcript.findIndex((row) => row.kind === "generated");
      expect(at).toBeGreaterThanOrEqual(0);
      const sourceRow = settledModel.transcript[at];
      if (sourceRow?.kind !== "generated" || sourceRow.source === undefined) {
        throw new Error("the settled history holds an admitted generated fragment");
      }
      // Recovered from the rows it was wrapped into, because the reading wraps
      // rather than clips: the whole of it is on the screen, across as many rows
      // as the pane needed, and concatenating the pane's own rows is what gets
      // it back.
      expect(says(page.frame(), "box:reading:viewport", sourceRow.source)).toBe(true);

      // 7. The complete binding value, from the drawer that holds it.
      // A catalog row: opened to reach it, and the choice closes it again.
      yield* openCatalog(page);
      yield* page.focus("entry:entry-1");
      yield* page.key("Enter");
      yield* page.until("the catalog closing behind the choice", (frame) => !catalogOpen(frame));
      // Through the tab, because the command's accepted default right pane is
      // the Sidekick: a person reading their bindings asks for them, and this
      // row is about what the binding's own drawer holds once they have.
      yield* selectPane(page, "bindings");
      yield* page.focus("binding:plan");
      yield* page.key("Enter");
      // The binding's own drawer, which is what naming it in a route opens.
      yield* page.until("the binding's drawer", (frame) => shows(frame, "[close]"));
      for (const line of JSON.stringify(PLAN, undefined, 2).split("\n")) {
        expect(shows(page.frame(), line)).toBe(true);
      }
      yield* page.key("Escape");
      yield* page.until(
        "the drawer closing",
        (frame) => frame.area("box:drawer:layer") === undefined,
      );

      // 8. The complete ordered set of History positions, as the drawer lists them.
      yield* page.focus("footer:history");
      yield* page.key("Enter");
      yield* page.until("the History drawer", historyOpen);
      const markers = positions(page.frame()).map((one) => one.text);
      expect(markers.length).toBeGreaterThan(4);

      // 9. The historical state a reader would want back: the terminal position,
      // read only, with the recorded question's drawer open on it.
      const terminalMarker = positions(page.frame()).at(-1);
      if (terminalMarker === undefined) {
        throw new Error("the History drawer lists positions");
      }
      yield* page.focus(terminalMarker.key);
      yield* page.key("Enter");
      yield* page.until("a frozen position", historical);
      yield* page.key("Escape");
      yield* page.until(
        "the drawer closing",
        (frame) => frame.area("box:drawer:layer") === undefined,
      );
      yield* page.focus(controlWith(page, "elicit:", "answered"));
      yield* page.key("Enter");
      yield* page.until("the retained answer's drawer", (frame) => shows(frame, "[close]"));

      // The reading this state *is*, said on the screen: an entry selected, a
      // recorded position being read, and the retained answer's drawer over it.
      //
      // The first two are read with the layer out of the way and the third with
      // it back. Closing keeps the position and the selection; only the layer
      // moves.
      yield* page.key("Escape");
      yield* page.until(
        "the drawer closing",
        (frame) => frame.area("box:drawer:layer") === undefined,
      );
      expect(selectedEntry(page.frame())).toContain("Entry 1");
      expect(historical(page.frame())).toBe(true);
      yield* page.focus(controlWith(page, "elicit:", "answered"));
      yield* page.key("Enter");
      yield* page.until("the retained answer's drawer", (frame) => shows(frame, "[close]"));
      // The whole retained schema and the whole retained answer, reached through
      // the drawer's own window.
      //
      // This drawer scrolls (#875). It used to describe every row at once and
      // let the layout clip whatever did not fit, which put the tail of a long
      // record in no cell, no target and no focus stop while still claiming to
      // show it — and cost this drawer its own `[close]`. So the claim is no
      // longer "every line is on screen together" but the stronger one: every
      // line is **reachable**, and the rows that are not visible are not mounted.
      const { first: firstFrame, reached } = yield* drawerContent(page);
      const retainedRows = [
        ...JSON.stringify(SCHEMA, undefined, 2).split("\n"),
        ...JSON.stringify(ANSWER, undefined, 2).split("\n"),
      ].map((line) => line.trim());
      for (const line of retainedRows) {
        expect(reached).toContain(line);
      }
      // And it really was a window rather than one tall drawer. This record is
      // longer than the drawer can hold — schema and answer together are more
      // rows than its rectangle has — so the rows on screen at the end are not
      // the rows that were on screen at the start. Without this, `toContain`
      // above would also pass on a drawer that described every row at once and
      // let the layout clip whatever did not fit.
      const content =
        JSON.stringify(SCHEMA, undefined, 2).split("\n").length +
        JSON.stringify(ANSWER, undefined, 2).split("\n").length;
      expect(firstFrame.length).toBeLessThan(content);
      expect(drawerRows(page.frame())).not.toEqual(firstFrame);

      yield* finish(page);
      // The canonical route that reading came to, taken where it is still
      // published: what the command returns on its way out. This is the string
      // the cold process below is given, so it is also what proves the route
      // survived the whole journey.
      const location = exitRoute(page).location();
      const decoded = decodeLocation(location);
      expect(decoded.ok).toBe(true);
      if (decoded.ok) {
        expect(decoded.value.scopes).toEqual(["entry-1"]);
        expect(decoded.value.at).toBeDefined();
        expect(decoded.value.inspect).toBe(true);
        expect(decoded.value.drawers.map((one) => one.kind)).toEqual(["recorded-elicit"]);
      }
      return { files: named, liveMarkers: markers, captured: location };
    });

    const lines = yield* records(retained, files[0]);
    expect(lines.length).toBeGreaterThan(0);

    // 10. A fresh host, with nothing but that location and the file.
    const { performed, second } = yield* scoped(function* () {
      const hosted = yield* useJourneyHost({ root: retained, reopening: true });
      const counted = yield* countPerformed();
      const page = yield* startJourney(hosted, { location: captured });

      // The same reading, rebuilt from the URL and the file alone — read with
      // the drawer the location restored closed: closing moves the layer and
      // nothing else; the drawer is reopened below for its own content.
      yield* page.until("the restored drawer", (frame) => shows(frame, "[close]"));
      yield* page.key("Escape");
      yield* page.until(
        "the drawer closing",
        (frame) => frame.area("box:drawer:layer") === undefined,
      );
      expect(selectedEntry(page.frame())).toContain("Entry 1");
      expect(historical(page.frame())).toBe(true);
      yield* page.focus(controlWith(page, "elicit:", "answered"));
      yield* page.key("Enter");
      yield* page.until("the retained drawer again", (frame) => shows(frame, "[close]"));

      // The same retained question: the whole schema and the whole answer, not a
      // label that happens to contain the word. Reached through the drawer's own
      // window, which a reopened process opens at its first row — how far a
      // window is scrolled is process-local and no location carries it.
      const reopened = yield* drawerContent(page);
      for (const line of [
        ...JSON.stringify(SCHEMA, undefined, 2).split("\n"),
        ...JSON.stringify(ANSWER, undefined, 2).split("\n"),
      ]) {
        expect(reopened.reached).toContain(line.trim());
      }

      // Then out from under the drawer, for the rest of what the file holds.
      yield* page.key("Escape");
      yield* page.until(
        "the drawer closing",
        (frame) => frame.area("box:drawer:layer") === undefined,
      );
      // The catalog is where this screen keeps the entries and their scopes, so
      // it is opened to read them and put away again before the reading below.
      yield* openCatalog(page);
      expect(page.frame().control("entry:entry-1")?.text).toContain("1. [ok] entry-1");
      expect(page.frame().control("scope:entry-1/Checklist-1")?.text).toContain(
        "component Checklist",
      );
      // Re-anchored for #881 PR 2: the transcript's `generated admitted:`
      // record row became the entry's reading, and the fragment this cold
      // process reconstructed is the catalog row that names it. The claim is
      // unchanged — a reopened process shows the generated region the first one
      // admitted.
      expect(page.frame().control("scope:entry-1/generated-1")?.text).toContain(
        "generated generated",
      );
      yield* closeCatalog(page);
      // The last of that reading, reached through its own window: the accepted
      // row of space above each column heading costs this column a row, so the
      // output the answer produced is a press down rather than drawn with the
      // rest of it. The retained string is unchanged.
      yield* scrollReadingTo(page, "Decision: approve");
      expect(shows(page.frame(), "Decision: approve")).toBe(true);

      // The same complete binding value, asked for the same way.
      yield* selectPane(page, "bindings");
      yield* page.focus("binding:plan");
      yield* page.key("Enter");
      yield* page.until("the binding's drawer", (frame) => shows(frame, "[close]"));
      for (const line of JSON.stringify(PLAN, undefined, 2).split("\n")) {
        expect(shows(page.frame(), line)).toBe(true);
      }
      yield* page.key("Escape");
      yield* page.until(
        "the drawer closing",
        (frame) => frame.area("box:drawer:layer") === undefined,
      );

      // And the same History positions, in the same order.
      yield* page.focus("footer:history");
      yield* page.key("Enter");
      yield* page.until("the History drawer", historyOpen);
      expect(positions(page.frame()).map((one) => one.text)).toEqual(liveMarkers);

      yield* finish(page);
      // The route came back out of the cold process the way it went in: the same
      // execution, the same selected scope and the same frozen position. The
      // drawer differs because this reading ends with History open, which is a
      // thing this process did rather than a thing the route carried in.
      const reopenedFields = exitRoute(page).route();
      const original = decodeLocation(captured);
      if (!original.ok) {
        throw original.error;
      }
      expect(reopenedFields.execution).toBe(original.value.execution);
      expect(reopenedFields.scopes).toEqual(original.value.scopes);
      expect(reopenedFields.at).toBe(original.value.at);
      expect(reopenedFields.inspect).toBe(original.value.inspect);
      return { performed: counted, second: page.repl.terminal };
    });

    // Nothing was performed again, and nothing was written.
    expect(performed.reads).toEqual([]);
    expect(performed.compiles).toBe(0);
    expect(performed.asked).toBe(0);
    expect(yield* records(retained, files[0])).toEqual(lines);
    expect(second.resets).toBe(1);
    expect(second.readers).toBe(0);
    expect(second.listeners).toBe(0);
  });
});

describe("REPL journey: when a frame counts as applied", () => {
  it("J1: a frame is not acknowledged until it has been presented", function* () {
    const clock = countingClock();

    yield* scoped(function* (): Operation<void> {
      const hosted = yield* useJourneyHost({ clock });
      const page = yield* startJourney(hosted);
      const { terminal } = page.repl;

      // Let the first frames through, then block inside the next presentation:
      // each tick the stream parks on is released until it parks on nothing.
      clock.hold();
      yield* lingering();
      while (clock.parked() > 0) {
        clock.release();
        yield* lingering();
      }
      // Counted before the frame is drawn, so what is measured is what *this*
      // frame caused rather than whatever had already happened.
      const before = clock.waits;
      terminal.holdNextPresent();
      // A resize, because it causes exactly one frame: a keystroke that moves
      // focus causes a second one to redraw the marker, and a count has to have a
      // baseline it can name.
      terminal.resized({ columns: 150, rows: 34 });
      yield* awaited("a presentation held", () => {
        clock.release();
        return terminal.holdPresent !== undefined;
      });
      const held = terminal.holdPresent;
      if (held === undefined) {
        throw new Error("a presentation was blocked so the frame stream could be read");
      }

      // The bytes are being written. The tick this frame is drawing with came from
      // a wait already counted, and because the frame has not been *applied* yet,
      // the stream has scheduled nothing behind it.
      clock.release();
      yield* lingering();
      expect(clock.waits).toBe(before);

      // Released, and only now does the stream move on.
      held.release();
      yield* awaited("the stream scheduling its next tick", () => {
        clock.release();
        return clock.waits > before;
      });

      yield* finish(page);
    });
  });
});

describe("Termless mounted adapter", () => {
  /** The screen and every wait, reader and listener released, and the modes restored once. */
  const released = (terminal: Terminal | undefined): void => {
    expect([
      terminal?.screen?.closed,
      terminal?.waiting,
      terminal?.readers,
      terminal?.listeners,
      terminal?.resets,
      terminal?.raw.at(-1),
    ]).toEqual([true, 0, 0, 0, 1, false]);
  };

  it("reads typing, diffs and every profile off completed presentations", function* () {
    const page = yield* useReplPage({ size: WIDE });
    const { terminal } = page.repl;
    const top = page.frame().rows[0];
    expect(top.trim().length).toBeGreaterThan(0);
    // The one fact of the identity row a diff would not repeat.
    const session = top.trim().split(/\s+/).at(-1) ?? "";
    const written = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

    const before = terminal.drawn;
    yield* draft(page).type("abc");
    expect(terminal.drawn).toBeGreaterThan(before);
    // The typed frame is a diff: it draws no identity row, and the owned screen
    // still has the one the first frame drew.
    expect(terminal.presented.some((bytes) => written(bytes).includes(session))).toBe(true);
    expect(written(terminal.presented.at(-1) ?? new Uint8Array()).includes(session)).toBe(false);
    expect(page.frame().rows[0]).toBe(top);

    for (const size of [MEDIUM, NARROW, WIDE]) {
      const frame = yield* page.resize(size);
      expect(frame.rows.length).toBe(size.rows);
      expect(frame.rows.filter((line) => line.length > size.columns)).toEqual([]);
      expect(draft(page).text()).toBe("abc");
    }
    expect(page.repl.outcome()).toBeUndefined();
  });

  it("puts a held write on the screen only once it completes, and a cancelled one never", function* () {
    const { page, readings } = yield* scoped(function* () {
      const mounted = yield* useReplPage();
      const { terminal } = mounted.repl;
      yield* draft(mounted).type("abc");

      const attempted = terminal.presented.length;
      const drawn = terminal.drawn;
      terminal.holdNextPresent();
      terminal.feed("x");
      yield* awaited("a held presentation", () => terminal.holdPresent !== undefined);
      expect(terminal.presented.length).toBeGreaterThan(attempted);
      expect(terminal.drawn).toBe(drawn);
      expect(draft(mounted).text()).toBe("abc");
      terminal.holdPresent?.release();
      yield* mounted.until("the released frame", () => draft(mounted).text() === "abcx");

      // Held again, and then the command's owner leaves with the write in flight.
      terminal.holdPresent = undefined;
      terminal.holdNextPresent();
      terminal.feed("y");
      yield* awaited("a second held presentation", () => terminal.holdPresent !== undefined);
      yield* spawn(() => mounted.until("a frame that never completes", () => false));
      yield* awaited("a wait subscribed to the next frame", () => terminal.waiting === 1);
      return { page: mounted, readings: { drawn: terminal.drawn, fed: terminal.fed } };
    });

    const { terminal } = page.repl;
    expect([terminal.drawn, terminal.fed]).toEqual([readings.drawn, readings.fed]);
    expect(draft(page).text()).toBe("abcx");
    released(terminal);
  });

  it("hands a failed write to the command's owner unchanged and releases the screen", function* () {
    const failure = new Error("this terminal stopped accepting writes");
    let terminal: Terminal | undefined;
    let fed = 0;
    let caught: unknown;
    try {
      yield* scoped(function* (): Operation<void> {
        const page = yield* useReplPage();
        terminal = page.repl.terminal;
        yield* spawn(() => page.until("a draft holding z", () => false));
        yield* awaited(
          "a wait subscribed to the next frame",
          () => page.repl.terminal.waiting === 1,
        );
        page.repl.terminal.failNextPresent(failure);
        page.repl.terminal.feed("z");
        fed = page.repl.terminal.fed;
        yield* suspend();
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(failure);
    expect(terminal?.fed).toBe(fed);
    released(terminal);
  });

  it("ends a wait the screen can no longer satisfy when the command exits", function* () {
    const { stopped, waited } = yield* scoped(function* () {
      const page = yield* useReplPage();
      const { terminal: ending } = page.repl;
      const pending = yield* spawn(function* (): Operation<unknown> {
        try {
          yield* page.until("something never drawn", () => false);
          return undefined;
        } catch (error) {
          return error;
        }
      });
      yield* awaited("a wait subscribed to the next frame", () => ending.waiting === 1);
      ending.end();
      const reason = yield* pending;
      expect(page.repl.outcome()?.ok).toBe(true);
      return { stopped: ending, waited: reason };
    });
    expect(String(waited)).toContain("the command ended before something never drawn");
    released(stopped);
  });
});

describe("REPL journey: resizing while a frame is being prepared", () => {
  it("J2: a window dragged while a frame is being prepared keeps the command", function* () {
    // Every frame the command presents, as it reports itself: the size it was
    // measured for and the profile it drew, in the order they reached the screen.
    const presented: { readonly size: ReplTerminalSize; readonly profile: string }[] = [];
    yield* ReplFrameWitness.around({
      *presented([facts], next) {
        presented.push({ size: facts.size, profile: facts.profile });
        yield* next(facts);
      },
    });

    yield* scoped(function* (): Operation<void> {
      const { page, root } = yield* mountJourney({ size: WIDE });
      const { terminal } = page.repl;

      // Settled wide, with something typed: a draft is state this product holds
      // nowhere but in the run, so it is the sharpest thing a rebuilt frame can
      // be shown to have kept.
      yield* draft(page).type("resize me");
      const wide = page.frame().rows;
      expect(wide.length).toBe(36);
      expect(shows(page.frame(), "resize me")).toBe(true);
      expect(shows(page.frame(), "TRANSCRIPT")).toBe(true);
      /** The execution this run opened, named by the file it created for it. */
      const execution = (yield* histories(root))[0]?.replace(/\.jsonl$/, "");
      expect(execution).toBeDefined();

      // Dragged between the read this frame's measurement was taken against and
      // the read that revalidates it. Which read of the wake that is was measured
      // against this program rather than promised by it — what the row asserts is
      // that the measured frame and the terminal were out of step, and the two
      // controls for it are what keep that honest.
      //
      // Three, because that is where the boundary is. One keystroke reads the
      // size at the too-small check, again to resolve the frame, a third time
      // for the measurement the frame is built from, and a fourth to
      // revalidate it. The third is the measurement, so a drag armed there
      // answers it with the old size and leaves the new one for the
      // revalidation to find. It was four while every action also measured a
      // frame before reducing; typing no longer does, and the read that
      // preparation performed is gone.
      const from = presented.length;
      terminal.resizeAfterRead(3, NARROW);
      yield* page.type("!");
      yield* page.until(
        "the second key carried to the new size",
        (frame) =>
          frame.size.columns === NARROW.columns &&
          frame.size.rows === NARROW.rows &&
          draftShows(page, "resize me!"),
      );

      // Alive, and still drawing.
      expect(presented.length).toBeGreaterThan(from);
      expect(terminal.size).toEqual(NARROW);
      // The *first* frame after the drag is already the new size: the one
      // measured for 160x36 was abandoned before it could be mounted, not drawn
      // and then corrected.
      expect(presented[from]?.size).toEqual(NARROW);
      const after = presented.slice(from);

      // Drawn for the terminal that is there now: twenty rows, none of them
      // wider than seventy-two columns. A frame that kept the measurement it
      // took at 160x36 would place rows this screen does not have.
      expect(page.frame().rows.length).toBe(NARROW.rows);
      expect(
        after.filter((one) => one.size.columns > NARROW.columns || one.size.rows > NARROW.rows),
      ).toEqual([]);

      // And it is the product, not a refusal — the routed surface it had, and the
      // draft it was carrying, on the row a person types on.
      expect(after.filter((one) => one.profile === "too-small")).toEqual([]);
      expect(routedSurface(page.frame())).toBe("Entries");
      expect(draftFocused(page.frame())).toBe(true);
      expect(draftShows(page, "resize me!")).toBe(true);

      // And the same again, but dragged for longer than one frame is allowed to
      // rebuild for. Every size read answers with the size that was there and
      // leaves a different one behind it, so every preparation — well past the
      // eight a single frame may spend — is invalidated before it can
      // revalidate, and the drag settles back at 72x20 at the end of it.
      const churned = presented.length;
      terminal.churnSize(60, NARROW);
      yield* page.type("?");
      yield* awaited("the drag running its course", () => terminal.churning() === 0);
      // Settled, the command draws the valid frame for the size that is there.
      yield* page.until(
        "the settled frame carrying both keys",
        (frame) => frame.size.rows === NARROW.rows && draftShows(page, "resize me!?"),
      );
      // Nothing presented while the terminal was moving wrote past the row the
      // settled terminal ends at. A frame measured for any of the sizes the drag
      // passed through would have — every one of them is taller than twenty rows
      // — so this is the assertion that says no stale geometry reached the
      // screen.
      const during = presented.slice(churned);
      expect(during.filter((one) => one.size.rows > NARROW.rows)).toEqual([]);
      // Sixty size reads, and at most one frame out of all of them — the one the
      // drag settled on. Two reads go into every preparation, so this is far past
      // the eight a single frame may spend: the rest were abandoned before they
      // were mounted, and none of them was acknowledged.
      expect(during.length).toBeLessThanOrEqual(1);
      expect(terminal.churning()).toBe(0);

      expect(terminal.size).toEqual(NARROW);
      // The *first* frame after the drag is the settled size, not any of the
      // sizes the drag passed through.
      expect(presented[churned]?.size).toEqual(NARROW);
      expect(page.frame().rows.length).toBe(NARROW.rows);
      // With the state it had before any of it: same execution, same route,
      // same draft — now carrying the second keystroke.
      expect(during.filter((one) => one.profile === "too-small")).toEqual([]);
      expect(routedSurface(page.frame())).toBe("Entries");
      expect(draftFocused(page.frame())).toBe(true);
      expect(draftShows(page, "resize me!?")).toBe(true);
      // A whole frame again, not a fragment: the footer's own rows are all back,
      // which a narrow frame draws beneath the one outlet it routes.
      expect(shows(page.frame(), "[history]")).toBe(true);
      expect(shows(page.frame(), COMPACT_HISTORY_TITLE)).toBe(true);
      expect((execution ?? "").length).toBeGreaterThan(0);

      yield* finish(page);
    });
  });
});

describe("REPL journey: the same product at every size", () => {
  it("J1: a long draft stays exact and usable at medium, and no row crosses its region", function* () {
    const source = yield* referenceSource();
    // Medium: a narrower content surface than wide, and an inspection column
    // beside it — so a location row written at the wide width would run into it.
    const { page } = yield* mountJourney({ size: MEDIUM });

    yield* paste(page, draft(page), source);

    // One row, and it says how many lines it is not showing. A draft this long
    // is read on the row it is typed on; its exact bytes are asserted at exit,
    // where the route still carries them, rather than off a clipped preview.
    expect(draftShows(page, source)).toBe(true);

    // And no row of the reading reaches past the surface it was placed in: the
    // columns to its right belong to the inspection column, and the layout
    // gave them to something else.
    const frame = page.frame();
    const surface = frame.area("box:transcript");
    const inspection = frame.area("box:inspection");
    expect(surface).toBeDefined();
    expect(inspection).toBeDefined();
    expect(surface?.bounds.width).toBeGreaterThan(0);
    expect((surface?.bounds.x ?? 0) + (surface?.bounds.width ?? 0)).toBeLessThanOrEqual(
      inspection?.bounds.x ?? 0,
    );
    expect(surface?.contains("footer:input")).toBe(true);
    expect(surface?.contains("sidekick:message")).toBe(false);
    expect(inspection?.contains("sidekick:message")).toBe(true);
    expect(inspection?.contains("footer:input")).toBe(false);

    yield* finish(page);
    // Every byte of it, where the route still publishes them.
    expect(exitRoute(page).route().draft).toBe(source);
  });

  it("J1: a drawer covers what it is in front of, at medium and at wide", function* () {
    const source = yield* referenceSource();

    for (const size of [MEDIUM, WIDE]) {
      yield* scoped(function* (): Operation<void> {
        const { page } = yield* mountJourney({ size });

        yield* paste(page, draft(page), source);
        yield* page.key("Enter");
        yield* dismissQuestion(page);
        // Across the rows this reading was cut into, not on one of them. The
        // source column reserves the rail, the separators and the status badge
        // out of the body, and the accepted body gutter takes two more cells
        // from each side — so a line of somebody's document is paid out over
        // more rows than it used to be. The text is the whole of what it was.
        yield* page.until("the transcript", (frame) =>
          says(frame, "box:reading:viewport", "About to evaluate:"),
        );

        // A transcript with something in it — recorded before anything covers it,
        // so what follows is a claim about coverage rather than about absence.
        // Texts that belong to the transcript and to nothing the drawer lists, so
        // finding one inside the drawer means it showed through.
        // Re-anchored for #881 PR 2: the transcript's record rows became the
        // entry's reading, so these are two lines of what that reading shows.
        // Both belong to it and to nothing this drawer lists — the retained
        // positions name `summarySource` and `<Checklist /> admitted`, so
        // neither `Source` nor `Checklist` would discriminate anything.
        const underneath = ["### Ship the REPL", "2 steps remain."];
        for (const text of underneath) {
          // Across the rows this column cut it into. The Transcript reserves
          // the rail, its separators and the status badge out of its body
          // before any source is cut, and the accepted sidebar width and body
          // gutter leave that body narrower — so a line of somebody's document
          // is paid out over more rows than it was. The coverage claims below
          // are positional and unaffected.
          expect([text, says(page.frame(), "box:reading:viewport", text)]).toEqual([text, true]);
        }

        // And then a drawer over it.
        yield* page.focus("footer:history");
        yield* page.key("Enter");
        yield* page.until("the History drawer", historyOpen);
        expect(shows(page.frame(), "History")).toBe(true);

        // None of it shows through: every row of the drawer's box reaches the
        // box's own right edge, so what it is in front of is behind it.
        const layer = page.frame().area("box:drawer:layer");
        if (layer === undefined) {
          throw new Error("the History drawer places its layer");
        }
        // The drawer's own rows: its rule, its title, one per position it lists,
        // and its close control. A drawer draws rows rather than filling its
        // box, so the rows below its last one are the transcript and are meant
        // to be.
        const drawn = positions(page.frame()).length + 2;
        expect(drawn).toBeGreaterThan(4);
        const rows = layer.rows();
        for (let row = 0; row < drawn; row += 1) {
          const inside = rows[row] ?? "";
          for (const text of underneath) {
            expect(inside.includes(text)).toBe(false);
          }
          // And positionally: no label this drawer lists is anywhere near this
          // long, so every column past it belongs to the drawer and must have
          // been painted by it. A drawer that stopped short would leave whatever
          // the transcript has out there exactly where it was. The drawer's own
          // top rule reaches that edge too, and is the drawer painting it.
          expect(inside.slice(LABEL_ROOM).replace(/─/g, "").trim()).toBe("");
        }

        yield* finish(page);
      });
    }
  });

  it("J1: narrow still routes one surface, with the location above it", function* () {
    const { page } = yield* mountJourney({ size: NARROW });

    // The routed surface, and the location above it — both, at the smallest
    // size this REPL draws at.
    expect(shows(page.frame(), "Entries")).toBe(true);
    expect(surfaceRouted(page.frame(), "Entries")).toBe(true);
    // One outlet takes the whole width: neither side column is placed.
    expect(page.frame().area("box:body")?.bounds.width).toBe(NARROW.columns);
    expect(page.frame().area("box:sidebar")).toBeUndefined();
    expect(page.frame().area("box:inspection")).toBeUndefined();
    // Narrow draws no dedicated location, at this size or any other.
    expect(page.frame().rows.some((line) => line.includes("xmd://"))).toBe(false);

    yield* finish(page);
    // The route it was at is still the base reading, published on the way out.
    expect(exitRoute(page).location()).toMatch(/^xmd:\/\/repl\/[A-Za-z0-9_-]+\/entries$/);
  });
});

/**
 * What this command settles before it is allowed to do anything.
 *
 * Each of these is about *order*. The command's refusals are cheap only while
 * nothing has happened yet: a terminal that is not one, a URL that names
 * something the file never held, a question that has already been answered.
 * Discovered late, each of them costs something that cannot be taken back — an
 * empty history nobody asked for, records a typo caused, a location naming a
 * drawer that is not there.
 */
describe("REPL journey: what it settles before it acts", () => {
  it("J1: a piped invocation refuses before a history file exists", function* () {
    // The one thing that differs from every other test here: this host's
    // standard streams are not a terminal.
    const { terminal, install } = recordingTerminal(WIDE, false);
    yield* scoped(function* (): Operation<void> {
      yield* install();
      const hosted = yield* useJourneyHost();

      // Spawned rather than awaited, so that a command which *fails* to refuse
      // is caught as a command still running instead of as a hanging test.
      let ran: Result<ReplOutcome> | undefined;
      yield* spawn(function* (): Operation<void> {
        ran = yield* runReplProgram({ profile: hosted.host.profile });
      });
      yield* awaited("the command refusing", () => ran !== undefined);

      // It came straight back. No screen was opened, so there is nothing to
      // drive and nothing to wait for.
      expect(ran).toBeDefined();
      expect(ran?.ok).toBe(false);
      if (ran !== undefined && !ran.ok) {
        expect(ran.error.message).toContain("not available over a pipe");
      }
      // Nothing was created. Not an empty history file, not the directory that
      // would hold one — the refusal happened before the repository did.
      expect(yield* until(readdir(hosted.root))).toEqual([]);
      // And nothing touched the terminal: no raw mode, no alternate screen, and
      // so nothing to reset.
      expect(terminal.raw).toEqual([]);
      expect(terminal.presented).toEqual([]);
      expect(terminal.resets).toBe(0);

      terminal.end();
    });
  });

  it("J1: a route naming a scope the history never had refuses before anything replays", function* () {
    const source = yield* referenceSource();
    const retained = yield* useTemporary("xmd-repl-journey-");

    // A history that is deliberately *unfinished*: the entry is admitted and
    // the run is holding at its question. Replaying one of these has somewhere
    // to go — it resumes, asks again and appends — which is exactly what a
    // route that cannot resolve must not be allowed to cause.
    const files = yield* scoped(function* (): Operation<string[]> {
      const { page } = yield* mountJourney({ root: retained });
      const named = yield* histories(retained);

      yield* paste(page, draft(page), source);
      yield* page.key("Enter");
      yield* page.until("the question", asked);

      // Left unanswered on purpose.
      yield* finish(page);
      return named;
    });

    const model = yield* projectionOf(retained, files[0]);
    expect(model.entries[0]?.scope).toBeDefined();
    const entryKey = model.entries[0]?.key ?? "";
    expect(model.settled).toBe(false);
    const lines = yield* records(retained, files[0]);

    // A URL a person could plausibly type: the execution is real, the entry is
    // real, and one segment of the path is a typo.
    const mistyped = encodeLocation({
      execution: files[0].replace(/\.jsonl$/, ""),
      surface: "entries",
      scopes: [entryKey, "Nowhere-9"],
      drawers: [],
      at: undefined,
      inspect: false,
      draft: undefined,
      session: undefined,
      view: undefined,
      right: undefined,
      sidekick: undefined,
    });

    const { performed, outcome } = yield* scoped(function* () {
      const hosted = yield* useJourneyHost({ root: retained, reopening: true });
      const counted = yield* countPerformed();
      const page = yield* startJourney(hosted, { location: mistyped });
      // A refusal screen, not a reconstruction: waited for by what it says
      // rather than by a full frame, because a refusal *is* one row.
      yield* page.until("the refusal", (frame) => shows(frame, "Nowhere-9"));

      // It names the segment it could not follow, rather than showing a view
      // of something the URL did not ask for.
      expect(shows(page.frame(), "holds no Nowhere-9")).toBe(true);

      return { performed: counted, outcome: yield* leave(page) };
    });

    expect(outcome.ok).toBe(false);
    // Nothing replayed. Nobody was asked the question a resumed run would have
    // asked again, no eval block was compiled, and the file is byte for byte
    // what the first process left behind.
    expect(performed.asked).toBe(0);
    expect(performed.compiles).toBe(0);
    expect(yield* records(retained, files[0])).toEqual(lines);
  });

  it("J1: a stale live-question URL refuses against a finished execution", function* () {
    const source = yield* referenceSource();
    const retained = yield* useTemporary("xmd-repl-journey-");

    // A history that ran to the end: the question was asked, answered and
    // recorded, and the root closed.
    const files = yield* scoped(function* (): Operation<string[]> {
      const { page } = yield* mountJourney({ root: retained });
      const named = yield* histories(retained);

      yield* paste(page, draft(page), source);
      yield* page.key("Enter");
      yield* openQuestion(page);
      yield* form(page).value("decision").type("approve");
      yield* page.key("Enter");
      // Reached through the reading's own window, for the accepted body gutter.
      yield* scrollReadingTo(page, "Decision: approve");
      yield* entrySettles(page, 1, "ok");

      yield* finish(page);
      return named;
    });

    const model = yield* projectionOf(retained, files[0]);
    expect(model.settled).toBe(true);
    const lines = yield* records(retained, files[0]);

    // The URL somebody kept from while the question was up. The execution it
    // names is real and the drawer it names was real — and the question is gone,
    // which no history records, so nothing this file holds could say otherwise.
    const stale = encodeLocation({
      execution: files[0].replace(/\.jsonl$/, ""),
      surface: "entries",
      scopes: [model.entries[0]?.key ?? ""],
      drawers: [{ kind: "live-elicit" }],
      at: undefined,
      inspect: false,
      draft: undefined,
      session: undefined,
      view: undefined,
      right: undefined,
      sidekick: undefined,
    });
    expect(stale).toContain("+elicit");

    const { performed, outcome } = yield* scoped(function* () {
      const hosted = yield* useJourneyHost({ root: retained, reopening: true });
      const counted = yield* countPerformed();
      const page = yield* startJourney(hosted, { location: stale });
      yield* page.until("the refusal", (frame) => shows(frame, "nothing is being asked"));

      return { performed: counted, outcome: yield* leave(page) };
    });

    // A refusal rather than a success with nothing on the screen, and the run it
    // would have replayed never happened.
    expect(outcome.ok).toBe(false);
    expect(performed.asked).toBe(0);
    expect(performed.compiles).toBe(0);
    expect(yield* records(retained, files[0])).toEqual(lines);
  });

  it("J1: an answered history with its root still open refuses the same URL", function* () {
    // The shape `settled` cannot speak for: the question was asked *and
    // answered*, and only the root close is missing. Reopening it asks nobody
    // anything — it finishes the root and stops — so a route that resolved its
    // live drawer here would replay, append that close, and only then discover
    // there was no drawer to mount.
    yield* useTempFileCompiler();
    const events = yield* referenceEvents();
    const unclosed = events.slice(0, -1);
    expect(events[events.length - 1]?.type).toBe("close");

    const { outcome, performed } = yield* scoped(function* () {
      const hosted = yield* useJourneyHost({ reopening: true });
      const directory = join(hosted.root, "xmd", "repl");
      yield* until(mkdir(directory, { recursive: true }));
      const written = join(directory, "unclosed.jsonl");
      yield* until(
        writeFile(written, unclosed.map((event) => serializeDurableEvent(event)).join("")),
      );
      const kept = yield* until(readFile(written, "utf8"));
      const counted = yield* countPerformed();

      const model = yield* projectionOf(hosted.root, "unclosed");
      expect(model.settled).toBe(false);
      expect(model.entries[0]?.scope.elicitations[0].answer).toEqual({ decision: "approve" });

      const page = yield* startJourney(hosted, {
        location: `xmd://repl/unclosed/entries/${model.entries[0]?.key ?? ""}/+elicit`,
      });
      yield* page.until("the refusal", (frame) => shows(frame, "nothing is being asked"));

      const result = yield* leave(page);
      // Nothing replayed, and the close this reopen would have written is not
      // there: the file is exactly the prefix that was handed to it.
      expect(yield* until(readFile(written, "utf8"))).toBe(kept);
      return { outcome: result, performed: counted };
    });

    expect(outcome.ok).toBe(false);
    expect(performed.asked).toBe(0);
    expect(performed.compiles).toBe(0);
  });

  it("J1: an accepted answer closes the drawer and clears it from the location", function* () {
    const source = yield* referenceSource();
    yield* scoped(function* (): Operation<void> {
      const { page, root } = yield* mountJourney();
      const files = yield* histories(root);

      yield* paste(page, draft(page), source);
      yield* page.key("Enter");
      yield* page.until("the question", asked);

      // Activating the announcement opens the drawer, and the drawer's own
      // controls are what say it is up.
      yield* openQuestion(page);
      yield* page.until("the question's drawer", (frame) => shows(frame, "[close]"));
      expect(shows(page.frame(), "[close]")).toBe(true);

      yield* form(page).value("decision").type("approve");
      yield* page.key("Enter");
      // Reached through the reading's own window, for the accepted body gutter.
      yield* scrollReadingTo(page, "Decision: approve");
      yield* page.until("the answer", (frame) => shows(frame, "Decision: approve"));

      // The question is over, so the drawer is over: its controls are off the
      // screen, and nothing it mounted is left behind.
      expect(shows(page.frame(), "[close]")).toBe(false);
      // And the form it was typed into is gone with it, rather than standing
      // there still offering the choices.
      expect(shows(page.frame(), "decision: approve | decline")).toBe(false);

      expect((yield* records(root, files[0])).length).toBeGreaterThan(0);
      yield* finish(page);
    });
  });

  it("J1: Continue is mounted only while a continuation is held", function* () {
    const source = yield* referenceSource();
    const { page } = yield* mountJourney();

    yield* paste(page, draft(page), source);
    expect(draftFocused(page.frame())).toBe(true);
    // Submit, then reach Pause by walking backwards one control — which is
    // the whole claim: while expansion is playing, Pause is the control
    // immediately before the draft because Continue is not mounted at all.
    yield* page.key("Enter");
    yield* page.type("\x1b[Z\r");

    yield* page.until("expansion paused", (frame) => shows(frame, "[pause] paused"));
    // Now a continuation is held, so the control that releases it exists.
    expect(page.frame().has("footer:continue")).toBe(true);

    yield* finish(page);
  });

  it("J1: Continue is refused while a pause is still being taken", function* () {
    // The state between asking and holding. A Continue accepted here would
    // withdraw the pause instead of releasing anything, so the reduction
    // refuses it — and says which of the two it is.
    const pausing = reduceRepl(initialState("abc"), { kind: "continue" }, EMPTY_MODEL_FOR_TEST, {
      output: "",
      question: undefined,
      expansion: "pausing",
      pausable: true,
      running: true,
      agent: NO_AGENT,
      lifecycle: NO_LIFECYCLE,
    });
    expect(pausing.intent.kind).toBe("none");
    expect(pausing.state.refusal).toContain("not paused");

    const held = reduceRepl(initialState("abc"), { kind: "continue" }, EMPTY_MODEL_FOR_TEST, {
      output: "",
      question: undefined,
      expansion: "paused",
      pausable: true,
      running: true,
      agent: NO_AGENT,
      lifecycle: NO_LIFECYCLE,
    });
    expect(held.intent.kind).toBe("continue");
    expect(held.state.refusal).toBe(undefined);
  });
});
/**
 * Pause during submission preparation (#883 PPA2–PPA5).
 *
 * The window these cases are about is the one between pressing Run and the
 * entry existing. Preflight validates the document — which reads the Markdown
 * definition of every component it names — and that read can suspend for as
 * long as a disk, an import or a provider takes. Submission is off the input
 * loop so that the person keeps their keyboard throughout it, and Pause is
 * offered from the moment the slot is reserved so that what they can do with
 * that keyboard includes stopping the entry they just asked for.
 *
 * The hold is proved against the real seam. One actual `validateDocument` read
 * is held through the runtime's own `API.Fs` middleware, the program is the
 * production assembly, and readiness comes from latches and the frames the
 * renderer actually presented. A fake `session.submit` would prove that this
 * suite can describe the behaviour, not that the product has it.
 */
describe("REPL journey: Pause reaches a submission before its entry exists", () => {
  /** The sizes this evidence covers, which are the three the product supports. */
  const SIZES: readonly ReplTerminalSize[] = [
    { columns: 160, rows: 36 },
    { columns: 120, rows: 30 },
    { columns: 72, rows: 20 },
  ];

  /** The Markdown definition the reference entry's first element names. */
  const DEFINITION = "Checklist.md";

  /**
   * Hold the one definition read a preflight makes, and release it on demand.
   *
   * The first read of that one path and no other, so what is held is the
   * validation and not the event loop: the screen keeps drawing, the draft keeps
   * taking bytes, and every other read — including the same component's import
   * once the entry really runs — goes straight through. Installed on the test's
   * own scope, which is outside the command, so it wraps the reads the command
   * makes without being part of what it installs.
   */
  function heldDefinition(path: string): {
    install(): Operation<void>;
    /** Resolves once the preflight is actually standing in that read. */
    readonly reached: Operation<void>;
    release(): void;
    readonly holding: boolean;
  } {
    const entered = withResolvers<void>();
    const gate = withResolvers<void>();
    let holding = false;
    let held = 0;
    return {
      get holding() {
        return holding;
      },
      reached: entered.operation,
      release(): void {
        gate.resolve();
      },
      *install(): Operation<void> {
        // Registered before anything waits on the gate, so a scope torn down
        // while the read is held releases it rather than joining a suspend
        // nobody is going to resolve.
        yield* ensure(() => gate.resolve());
        yield* API.Fs.around({
          *readTextFile([one], next) {
            if (held > 0 || !one.endsWith(path)) {
              return yield* next(one);
            }
            held += 1;
            holding = true;
            entered.resolve();
            try {
              yield* gate.operation;
            } finally {
              holding = false;
            }
            return yield* next(one);
          },
        });
      },
    };
  }

  /**
   * Hold the first runtime execution before its document is delegated.
   *
   * The window this opens is the one the early-live route was reachable
   * through: the entry has a task and the session says work is in flight, but
   * the record that gives the entry a position has not been written, so there
   * is nothing yet for a hold to hold. Only the first one, so the successor an
   * entry is followed by runs ordinarily.
   */
  function heldStartup(): {
    install(): Operation<void>;
    /** Resolves once a real execution is standing in front of its document. */
    readonly reached: Operation<void>;
    release(): void;
  } {
    const entered = withResolvers<void>();
    const gate = withResolvers<void>();
    let held = 0;
    return {
      reached: entered.operation,
      release(): void {
        gate.resolve();
      },
      *install(): Operation<void> {
        yield* ensure(() => gate.resolve());
        yield* Execution.around({
          *document([request], next): Operation<void> {
            if (held > 0) {
              return yield* next(request);
            }
            held += 1;
            entered.resolve();
            yield* gate.operation;
            return yield* next(request);
          },
        });
      },
    };
  }

  /**
   * Refuse one runtime root metadata composition, once.
   *
   * Installed *inside* `Execution.document`, so it belongs to the runtime
   * invocation and not to the preflight that validated it: refusing the
   * preflight would be the ordinary refusal PPA3(a) already covers, and the
   * interval this is about is the one after the entry has been admitted. Root
   * metadata and the document envelope are composed there, before the body
   * expands and before any gate is crossed — which is the one place an entry
   * can be armed, hold nothing, and then fail.
   *
   * Composition is synchronous, so the seam cannot be held open and `at` is
   * called in it rather than waited for. What a caller can read there is
   * whatever it can read without suspending.
   */
  function refusedRootMetadata(at: () => void): { install(): Operation<void> } {
    let refused = 0;
    return {
      *install(): Operation<void> {
        yield* Execution.around({
          *document([request], next): Operation<void> {
            yield* RootMetadata.around({
              metadata(args, delegate) {
                if (refused > 0) {
                  return delegate(...args);
                }
                refused += 1;
                at();
                throw new Error("runtime metadata refusal after root import");
              },
            });
            return yield* next(request);
          },
        });
      },
    };
  }

  /** Whether a placed control is nothing but this word, so focus could rest on the word. */
  function standsAlone(frame: PageFrame, word: string): boolean {
    return frame
      .keys()
      .some((key) => (frame.control(key)?.text ?? "").replace(/^>\s+/, "").trim() === word);
  }

  /** The footer's one action row, at whatever size this terminal is. */
  function actionRow(frame: PageFrame): string {
    // The row the footer controls are placed on, found by the way out's own
    // placement: how many rows a footer takes is the composition's, and this
    // screen keeps its controls on one compact History row with the guidance
    // below it.
    const exit = frame.control("footer:exit");
    return exit === undefined ? "" : (frame.rows[exit.bounds.y] ?? "");
  }

  /** The row that states the lifecycle phase, wherever this screen says it. */
  function phaseRow(frame: PageFrame, word: string): string {
    return frame.rows.find((line) => line.includes(word)) ?? "";
  }

  /**
   * Count how often the reference entry's first authored step actually runs.
   *
   * The first thing its author wrote is the eval block at the top of
   * `fixtures/repl/entry.md`, and a hold that is early enough has to be earlier
   * than that. Counting the *invocation* rather than the compilation is the
   * whole point: a block is compiled before it is run, so a compile count would
   * go up at a hold that was working correctly. Counting the drawn row or the
   * later question would be looser still — a row that has not been painted yet
   * and a step that never ran look the same from the terminal.
   *
   * Wrapped around the real compiler rather than replacing it: the block that
   * runs is the one the production compiler produced, and only the first one is
   * wrapped, so a later block cannot add to this entry's count.
   */
  function* countFirstEval(): Operation<{ readonly invoked: number }> {
    const counted = { invoked: 0 };
    let wrapped = false;
    yield* API.Env.around({
      *compile([source, options], next) {
        const block = yield* next(source, options);
        if (wrapped) {
          return block;
        }
        wrapped = true;
        return (env: Record<string, unknown>) => {
          counted.invoked++;
          return block(env);
        };
      },
    });
    return counted;
  }

  for (const size of SIZES) {
    const at = `${size.columns}x${size.rows}`;

    it(`PPA2/PPA5: Pause is offered, requested and applied to the exact entry at ${at}`, function* () {
      const source = yield* referenceSource();
      const preflight = heldDefinition(DEFINITION);

      yield* scoped(function* (): Operation<void> {
        const hosted = yield* useJourneyHost();
        const root = hosted.root;
        const performed = yield* countPerformed();
        // Installed after the compiler it wraps, so what it counts is the block
        // the production compiler returned.
        const authored = yield* countFirstEval();
        yield* preflight.install();
        const page = yield* startJourney(hosted, { size });
        const files = yield* histories(root);

        yield* paste(page, draft(page), source);
        expect(draftFocused(page.frame())).toBe(true);

        // 1. Run. The slot is reserved and the preflight is already suspended in
        // the definition read, so this is the whole window the amendment is
        // about: the entry does not exist and will not for as long as that read
        // is held.
        yield* page.key("Enter");
        yield* preflight.reached;
        yield* page.until("the submission preparing", (one) => shows(one, "[pause] preparing"));
        expect(preflight.holding).toBe(true);
        // Nothing is admitted and nothing is held: there is no entry, so there
        // is no continuation, so there is nothing for Continue to release.
        expect(page.frame().has("footer:continue")).toBe(false);
        expect(yield* records(root, files[0] ?? "")).toEqual([]);

        // PPA5. The button, the state and nothing else, in the accepted order —
        // and the state is text. Backtab from the draft reaches Pause, because
        // the word beside it is not a focus stop and Continue is not mounted.
        const preparing = actionRow(page.frame());
        // The control is on the footer's own row and the phase is stated as
        // text. They are two rows of this screen rather than two words of one:
        // the controls keep the compact History row and the phase is said in
        // the band below it, which is what makes the phase a sentence a reader
        // can read rather than whatever the control row had left.
        expect(preparing).toContain("[pause]");
        expect(phaseRow(page.frame(), "preparing")).toContain("preparing");
        expect(page.frame().rows.length).toBe(size.rows);
        yield* page.key("Backtab");
        yield* page.until("Pause holding focus", (one) => one.focused === "footer:pause");
        expect(page.frame().focused).toBe("footer:pause");
        expect(standsAlone(page.frame(), "preparing")).toBe(false);

        // 2. Activate it. The request stands against this exact submission and
        // stops nothing yet, so the word changes and Continue stays away.
        yield* page.key("Enter");
        yield* page.until("the request standing", (one) => shows(one, "[pause] pausing"));
        expect(page.frame().has("footer:continue")).toBe(false);
        // Still the same control, still holding focus: one mounted identity
        // across the whole of this, which is what keeps a person's place.
        expect(page.frame().focused).toBe("footer:pause");
        // And still nothing admitted — asking an entry to stop is not starting
        // it, and it is not cancelling the preparation either.
        expect(yield* records(root, files[0] ?? "")).toEqual([]);
        expect(performed.asked).toBe(0);

        // 3. Release the validation. The entry starts, is admitted, and holds —
        // before anything its author wrote has taken effect.
        preflight.release();
        yield* page.until("the exact entry held", (one) => shows(one, "[pause] paused"));
        expect(page.frame().has("footer:continue")).toBe(true);
        // The first thing this document's author wrote that anything outside it
        // can see is its question, and it has not been asked. Counted at the
        // seam that performs it as well as read off the screen: a row that has
        // not been drawn yet and a question that was never asked look the same
        // from the terminal alone.
        expect(asked(page.frame())).toBe(false);
        expect(performed.asked).toBe(0);
        // And the first thing the author wrote has not run. The question is the
        // last of four authored steps, so a hold that stopped anywhere among
        // them would still show no question; this says the hold is earlier than
        // all of them.
        expect(authored.invoked).toBe(0);
        // The entry it holds is the one that was submitted, admitted under the
        // source that was reserved. The request changed neither.
        const admitted = yield* projectionOf(root, files[0] ?? "");
        expect(admitted.entries.map((entry) => entry.key)).toEqual(["entry-1"]);
        expect(admitted.entries[0]?.source).toBe(source);

        // PPA5 again, now that a continuation is held: the state word sits
        // between the button and Continue, and is still not a focus stop.
        const paused = actionRow(page.frame());
        expect(paused.indexOf("[pause]")).toBeLessThan(paused.indexOf("paused"));
        expect(paused.indexOf("paused")).toBeLessThan(paused.indexOf("[continue]"));
        expect(page.frame().rows.length).toBe(size.rows);
        expect(page.frame().focused).toBe("footer:pause");

        // 4. Continue releases the hold, and the effect it was held before
        // happens once.
        yield* page.focus("footer:continue");
        yield* page.key("Enter");
        yield* page.until("the authored question", asked);
        expect(performed.asked).toBe(1);
        // Released, not replayed: the step the hold stood before has now run,
        // and run once. A hold that re-ran what it released would show two.
        expect(authored.invoked).toBe(1);
        yield* lingering();
        expect(performed.asked).toBe(1);
        expect(authored.invoked).toBe(1);
        // One entry, one source, start to finish.
        const after = yield* projectionOf(root, files[0] ?? "");
        expect(after.entries.map((entry) => entry.key)).toEqual(["entry-1"]);
        expect(after.entries[0]?.source).toBe(source);

        yield* finish(page);
      });
    });
  }

  /**
   * Clear the draft the way a person does, one key at a time.
   *
   * There is no host call that empties it: the draft is a field, and what
   * empties a field is the key that deletes a character. A scenario that reached
   * past the field would be a scenario proving the field was never involved.
   */
  function* erase(page: ReplPage, characters: number): Operation<void> {
    yield* page.focus("footer:input");
    for (let press = 0; press < characters; press += 1) {
      yield* page.key("Backspace");
    }
    yield* page.until("the draft emptied", () => draft(page).text() === "");
  }

  it("PPA1: one burst submits and requests the pause, with no frame in between", function* () {
    // The two J1 rows feed Run and the Backtab that reaches Pause as separate
    // writes, and a batch boundary falls between them — so the frame at the end
    // of the first batch is what mounts Pause for the second. This row removes
    // that help: both keys arrive in one write, so they are one batch, and the
    // tree that answers the Backtab is the one Run left behind. Without a mount
    // inside the batch the Backtab reaches `[exit]` and Enter ends the command.
    const source = yield* referenceSource();
    const preflight = heldDefinition(DEFINITION);

    yield* scoped(function* (): Operation<void> {
      const hosted = yield* useJourneyHost();
      const root = hosted.root;
      yield* preflight.install();
      const page = yield* startJourney(hosted);
      const files = yield* histories(root);

      yield* paste(page, draft(page), source);
      expect(draftFocused(page.frame())).toBe(true);

      // Submit, walk back one control, activate it. One write, so nothing is
      // read and nothing waits.
      yield* page.type("\r\x1b[Z\r");
      yield* preflight.reached;
      yield* page.until("the request standing", (one) => shows(one, "[pause] pausing"));
      // The command is still running: the Backtab reached Pause, not the way out.
      expect(page.repl.outcome()).toBeUndefined();
      expect(page.frame().has("footer:continue")).toBe(false);

      // And it was this submission's request: the entry it names holds.
      preflight.release();
      yield* page.until("the exact entry held", (one) => shows(one, "[pause] paused"));
      expect(page.frame().has("footer:continue")).toBe(true);
      const admitted = yield* projectionOf(root, files[0] ?? "");
      expect(admitted.entries.map((entry) => entry.key)).toEqual(["entry-1"]);

      yield* finish(page);
    });
  });

  it("PPA3(a): a refused preflight discards its pause request, and the next entry plays", function* () {
    // Invalid, and invalid *after* the definition it names: the component is
    // resolved — which is the read this holds — and then nothing supplies the
    // second one, so the refusal is an ordinary preflight refusal rather than a
    // document that was never read.
    const refusedSource = '<Checklist title="held" steps={1} />\n\n<Nowhere />';
    const valid = yield* referenceSource();
    const preflight = heldDefinition(DEFINITION);

    yield* scoped(function* (): Operation<void> {
      const hosted = yield* useJourneyHost();
      const root = hosted.root;
      const performed = yield* countPerformed();
      yield* preflight.install();
      const page = yield* startJourney(hosted);
      const files = yield* histories(root);

      yield* paste(page, draft(page), refusedSource);
      yield* page.key("Enter");
      yield* preflight.reached;
      yield* page.until("the submission preparing", (one) => shows(one, "[pause] preparing"));

      // Armed against a submission that is about to be refused.
      yield* page.focus("footer:pause");
      yield* page.key("Enter");
      yield* page.until("the request standing", (one) => shows(one, "[pause] pausing"));

      preflight.release();
      // Refused, and said so. Nothing was admitted and the draft is the one
      // thing a person needs back.
      yield* page.until("the refusal", (one) => one.rows.some((line) => line.includes("!")));
      expect(yield* records(root, files[0] ?? "")).toEqual([]);
      expect(shows(page.frame(), "<Nowhere />")).toBe(true);
      // The request went with the submission it belonged to. There is no
      // preparation and no live entry, so there is no Pause at all.
      yield* page.until("no preparation left", (one) => !shows(one, "[pause]"));
      expect(page.frame().has("footer:continue")).toBe(false);

      // The successor, submitted into the same session and the same controller.
      // It plays: the refused request did not survive to be applied to it.
      yield* erase(page, refusedSource.length);
      yield* paste(page, draft(page), valid);
      yield* page.key("Enter");
      yield* page.until("the successor's question", asked);
      expect(performed.asked).toBe(1);
      // Never held, so never continued: the effect happened without anybody
      // releasing anything.
      expect(page.frame().has("footer:continue")).toBe(false);
      expect(shows(page.frame(), "[pause] paused")).toBe(false);
      expect(shows(page.frame(), "[pause] pausing")).toBe(false);
      const admitted = yield* projectionOf(root, files[0] ?? "");
      expect(admitted.entries.map((entry) => entry.key)).toEqual(["entry-1"]);
      expect(admitted.entries[0]?.source).toBe(valid);

      yield* finish(page);
    });
  });

  it("PPA3(b): an entry armed with no hold is disarmed by its own failure", function* () {
    const source = yield* referenceSource();
    const preflight = heldDefinition(DEFINITION);
    /** What the refusal could see of this entry's authored work, from inside it. */
    let atSeam: number | undefined;

    yield* scoped(function* (): Operation<void> {
      const hosted = yield* useJourneyHost();
      const root = hosted.root;
      const performed = yield* countPerformed();
      const authored = yield* countFirstEval();
      yield* preflight.install();
      yield* refusedRootMetadata(() => {
        atSeam = authored.invoked;
      }).install();
      const page = yield* startJourney(hosted, { size: WIDE });
      const files = yield* histories(root);

      yield* paste(page, draft(page), source);

      // Pause asked for before the entry exists, which is the request this row
      // is about: it is still only a request when the thing that fails happens.
      yield* page.key("Enter");
      yield* preflight.reached;
      yield* page.until("the submission preparing", (one) => shows(one, "[pause] preparing"));
      yield* page.focus("footer:pause");
      yield* page.key("Enter");
      yield* page.until("the request standing", (one) => shows(one, "[pause] pausing"));

      // The entry starts, is admitted, takes the request — and then fails while
      // its root metadata is composed, before the body expands. The failure is
      // the entry's own and reaches the screen.
      preflight.release();
      // Failed as an entry, not refused as a submission: it was admitted, so it
      // has a position of its own to carry its failure.
      // The History rail marks it, with no catalog open: a wait that had to
      // open a drawer would be changing the screen it was waiting on.
      yield* entrySettles(page, 1, "err");
      // Read from inside the refusal: by the time it fails the entry is armed,
      // and nothing its author wrote has run. The body was never reached, so
      // the hold it was asked for had nothing to be early for.
      expect(atSeam).toBe(0);
      expect(performed.asked).toBe(0);
      // Disarmed by the cleanup the entry registered before it was armed, and
      // disarmed without releasing a hold nobody is standing in: once the entry
      // is gone there is no preparation and no live expansion, so there is no
      // Pause at all and nothing ever offered Continue.
      yield* page.until("no mode left behind", (one) => !shows(one, "[pause]"));
      expect(page.frame().has("footer:continue")).toBe(false);
      // Readable, and readable as one failed entry rather than as wreckage.
      const failed = yield* projectionOf(root, files[0] ?? "");
      expect(failed.entries.map((entry) => entry.key)).toEqual(["entry-1"]);

      // The successor, into the same session and the same controller. It plays:
      // the mode the failed entry asked for is not waiting for it, so its first
      // authored step happens with nobody releasing anything.
      //
      // Back to the draft first: the last thing activated was Pause, and the
      // control it was is not there any more.
      yield* page.focus("footer:input");
      expect(draftFocused(page.frame())).toBe(true);
      yield* paste(page, draft(page), source);
      yield* page.key("Enter");
      yield* page.until("the successor's question", asked);
      expect(authored.invoked).toBe(1);
      expect(performed.asked).toBe(1);
      expect(page.frame().has("footer:continue")).toBe(false);
      expect(shows(page.frame(), "[pause] paused")).toBe(false);
      expect(shows(page.frame(), "[pause] pausing")).toBe(false);
      const after = yield* projectionOf(root, files[0] ?? "");
      expect(after.entries.map((entry) => entry.key)).toEqual(["entry-1", "entry-2"]);

      yield* finish(page);
    });
  });

  it("PPA3(c): Pause during startup waits for the entry it names", function* () {
    const source = yield* referenceSource();
    const startup = heldStartup();

    yield* scoped(function* (): Operation<void> {
      const hosted = yield* useJourneyHost();
      const root = hosted.root;
      const performed = yield* countPerformed();
      const authored = yield* countFirstEval();
      yield* startup.install();
      const page = yield* startJourney(hosted, { size: WIDE });
      const files = yield* histories(root);

      yield* paste(page, draft(page), source);

      // Run, and let the preflight through. What is held is further in than
      // PPA2's window: the entry has a task, the session is doing work, and the
      // execution is standing in front of its own document — and still nothing
      // has been admitted.
      yield* page.key("Enter");
      yield* startup.reached;
      expect(yield* records(root, files[0] ?? "")).toEqual([]);

      // Pause now, through the mounted control. There is no entry to stop, so
      // there is nothing to offer a controller for: the request stands against
      // the reservation exactly as it would have during the preflight.
      yield* page.until("the submission preparing", (one) => shows(one, "[pause] preparing"));
      expect(page.frame().has("footer:continue")).toBe(false);
      yield* page.focus("footer:pause");
      yield* page.key("Enter");
      yield* page.until("the request standing", (one) => shows(one, "[pause] pausing"));
      // Pending, and pending because there is nothing it could have taken: no
      // continuation is held, so Continue is absent, and the file still says
      // nothing was submitted. A hold taken here would be a hold on the import
      // that gives the entry its position.
      expect(page.frame().has("footer:continue")).toBe(false);
      expect(shows(page.frame(), "[pause] paused")).toBe(false);
      expect(yield* records(root, files[0] ?? "")).toEqual([]);
      expect(authored.invoked).toBe(0);

      // Release the startup. Now the entry is admitted, and the request it has
      // been holding reaches it — before its author's first step.
      startup.release();
      yield* page.until("the exact entry held", (one) => shows(one, "[pause] paused"));
      expect(page.frame().has("footer:continue")).toBe(true);
      expect(authored.invoked).toBe(0);
      expect(performed.asked).toBe(0);
      const admitted = yield* projectionOf(root, files[0] ?? "");
      expect(admitted.entries.map((entry) => entry.key)).toEqual(["entry-1"]);
      expect(admitted.entries[0]?.source).toBe(source);

      // And Continue runs the step the hold stood before, once.
      yield* page.focus("footer:continue");
      yield* page.key("Enter");
      yield* page.until("the authored question", asked);
      expect(authored.invoked).toBe(1);
      expect(performed.asked).toBe(1);
      yield* lingering();
      expect(authored.invoked).toBe(1);
      expect(performed.asked).toBe(1);

      yield* finish(page);
    });
  });

  it("PPA3(d): walking away from the head while a preflight is held admits nothing", function* () {
    // Two entries' worth of draft, because freezing the view needs a recorded
    // position to freeze at — so the first one is admitted ordinarily and the
    // second is the one this row is about.
    const first = "<Output>one</Output>";
    const second = '<Checklist title="second" steps={1} />';
    const preflight = heldDefinition(DEFINITION);

    yield* scoped(function* (): Operation<void> {
      const hosted = yield* useJourneyHost();
      const root = hosted.root;
      yield* preflight.install();
      const page = yield* startJourney(hosted, { size: WIDE });
      const files = yield* histories(root);

      // One recorded entry, admitted the ordinary way. Its source names no
      // component, so the held definition read is not reached by it.
      yield* submitted(page, first);
      yield* entrySettles(page, 1, "ok");
      expect(preflight.holding).toBe(false);

      // The second, which does name it — so submitting suspends in the
      // validation and the keyboard is still the person's throughout.
      yield* paste(page, draft(page), second);
      yield* page.key("Enter");
      yield* preflight.reached;
      expect(preflight.holding).toBe(true);

      // And while it is held, they walk back to the recorded position. Nothing
      // about this is a withdrawal: they did not press Stop and they did not
      // edit anything — they are reading their own history.
      yield* page.focus("footer:history");
      yield* page.key("Enter");
      yield* page.until("the History drawer", historyOpen);
      yield* page.focus(markerKey(page, "Entry 1 admitted"));
      yield* page.key("Enter");
      yield* page.until("a frozen position", historical);

      // Released. The preflight succeeds, and the submission is refused at the
      // entry's actual start rather than admitted: the route it was reserved
      // against is not the route anybody is standing at any more.
      preflight.release();
      yield* page.until("the refusal at the start", (one) =>
        shows(one, "moved away from the live head"),
      );
      // One entry, which is the one that was admitted before any of this.
      const after = yield* projectionOf(root, files[0] ?? "");
      expect(after.entries.map((entry) => entry.key)).toEqual(["entry-1"]);
      expect(after.entries[0]?.source).toBe(first);
      // And the draft they never got to submit is still theirs.
      yield* page.key("Escape");
      yield* page.until("the drawer closing", (one) => one.area("box:drawer:layer") === undefined);
      yield* page.focus("footer:live");
      yield* page.key("Enter");
      yield* page.until("the head", (one) => !historical(one));
      expect(shows(page.frame(), second)).toBe(true);

      yield* finish(page);
    });
  });

  it("PPA4: the keyboard still works while a preflight is held, and closing discards the request", function* () {
    // One line, so what the draft row says is the draft itself rather than a
    // count of lines — and naming the definition this holds, so submitting it
    // is what suspends in the read.
    const held = '<Checklist title="held" steps={1} />';
    const typed = " and more";
    const preflight = heldDefinition(DEFINITION);
    const retained = yield* useTemporary("xmd-repl-journey-");

    const { location, execution } = yield* scoped(function* () {
      const hosted = yield* useJourneyHost({ root: retained });
      const performed = yield* countPerformed();
      yield* preflight.install();
      const page = yield* startJourney(hosted);
      const files = yield* histories(retained);

      yield* paste(page, draft(page), held);
      yield* page.key("Enter");
      yield* preflight.reached;
      yield* page.until("the submission preparing", (one) => shows(one, "[pause] preparing"));
      yield* page.focus("footer:pause");
      yield* page.key("Enter");
      yield* page.until("the request standing", (one) => shows(one, "[pause] pausing"));

      // The whole point of taking submission off the loop: the read is still
      // suspended, and the keyboard still reaches the draft. Asserted *before*
      // the release, so what is proved is that the edit was processed while the
      // validation was held rather than after it finished.
      yield* draft(page).type(typed);
      expect(preflight.holding).toBe(true);
      expect(draftShows(page, held + typed)).toBe(true);

      // And Exit reaches the command while it is still held. This cancels and
      // joins the work the submission owns; nothing is admitted, and no
      // terminal is invented for an entry that never existed.
      yield* page.focus("footer:exit");
      yield* page.key("Enter");
      yield* returned(page);
      // Joined, not abandoned: the read the submission was standing in unwound
      // with the task that owned it, so the command did not return while work
      // it started was still suspended somewhere.
      expect(preflight.holding).toBe(false);
      expect(yield* records(retained, files[0] ?? "")).toEqual([]);
      expect(performed.asked).toBe(0);

      // The location it prints carries the newer draft, not the source that was
      // reserved: what was prepared was never admitted, and what the person has
      // is what they typed.
      const exited = exitRoute(page);
      expect(exited.route().draft).toBe(held + typed);
      return { location: exited.location(), execution: exited.route().execution };
    });

    // A cold reopen of exactly that location, structurally unable to start an
    // execution. Nothing of the preparation comes back: it was this process's,
    // and no record carries it.
    yield* scoped(function* (): Operation<void> {
      const hosted = yield* useJourneyHost({ root: retained, reopening: true });
      const performed = yield* countPerformed();
      const page = yield* startJourney(hosted, { location });
      yield* lingering();

      // The draft is restored and nothing else is: no preparation, no request,
      // and no Pause, because there is no submission and no live entry.
      expect(draftShows(page, held + typed)).toBe(true);
      expect(shows(page.frame(), "[pause]")).toBe(false);
      expect(shows(page.frame(), "preparing")).toBe(false);
      expect(shows(page.frame(), "pausing")).toBe(false);
      expect(page.frame().has("footer:continue")).toBe(false);
      // And no work started on its own: a reopened location is something to
      // read, not something to run.
      expect(performed.asked).toBe(0);
      expect(performed.compiles).toBe(0);
      expect(yield* records(retained, execution)).toEqual([]);

      yield* finish(page);
    });
  });
});

/**
 * What a held run has already printed is on the screen while it is held.
 *
 * The elicitation provider is stopped before it registers its question, so the
 * run is inside the document with nothing pending: no question to show, no
 * answer to append, and the last thing it did was print. What it printed has
 * to be readable *then* rather than when the run finishes, because the overlay
 * exists precisely to show what the Journal has not settled yet.
 *
 * This pins the product's behaviour, not the wake that delivers it: expansion
 * moves around every element, so a frame is owed at nearly the same instant
 * for a second reason. `repl-execution.test.ts` covers the overlay's own
 * report of its output, which is the part that has no other announcer.
 */
describe("REPL journey: output nothing records still reaches the screen", () => {
  /** Distinctive, so finding it on the screen cannot be finding something else. */
  const PRINTED = "the-last-thing-this-document-prints";

  it("J1: text the Journal has not settled is drawn while the run is held", function* () {
    const gate = withResolvers<void>();
    let held = 0;
    // One durable record, then plain text, then the question. The text is the
    // last thing this document does before it blocks, so no record follows it
    // and nothing but the text itself can ask for the frame that shows it.
    const source =
      "```js eval\n" +
      'const schema = { type: "object", properties: ' +
      '{ decision: { type: "string", enum: ["yes"] } }, ' +
      'required: ["decision"], additionalProperties: false };\n' +
      "```\n\n" +
      `${PRINTED}\n\n` +
      '<Elicit schema={schema} as="answer">Decide?</Elicit>\n';

    yield* scoped(function* (): Operation<void> {
      const hosted = yield* useJourneyHost();

      // Held *before* the question is registered, so nothing about it has
      // reached this process yet: no pending question, no wake.
      yield* Elicitation.around({
        *elicit([request], next) {
          held += 1;
          yield* gate.operation;
          return yield* next(request);
        },
      });

      const page = yield* startJourney(hosted);
      const files = yield* histories(hosted.root);

      yield* paste(page, draft(page), source);
      yield* page.key("Enter");

      // Wait for the run to reach the question and stop there.
      yield* awaited("the run reaching its question", () => held > 0);
      // The text after the last record this document writes. Nothing recorded
      // it, nothing reprojected because of it, and it is on the screen — across
      // the rows the Transcript's own body cut it into. This one has no spaces
      // to wrap at, so the column cuts it at a code unit and the rows are
      // rejoined with nothing between them.
      yield* page.until("the printed text", (frame) => saysJoined(frame, PRINTED));
      // Then let it sit, with nothing else able to move.
      yield* lingering();

      // No question is pending, so nothing but output has woken this screen.
      //
      // Re-anchored for #881 PR 2: the Transcript now shows the entry's own
      // source, and `Decide?` is written in it — so the absence of a question
      // is asserted as the absence of a question rather than as the absence of
      // its words. That is the stronger claim and the one the reading makes:
      // source on the screen never proves anything is waiting.
      expect(asked(page.frame())).toBe(false);
      expect(saysJoined(page.frame(), PRINTED)).toBe(true);

      gate.resolve();
      yield* page.until("the question", asked);
      expect((yield* records(hosted.root, files[0])).length).toBeGreaterThan(0);

      yield* finish(page);
    });
  });
});

/**
 * The history action against a prefix the selected entry predates (#827 ER1).
 *
 * Through the running command, because the clearing is a decision the loop
 * makes with a model it has just reprojected: the view the standing route asks
 * for does not resolve at the chosen position, and what the loop does about
 * that is the behavior. Driving the reducer alone would prove the decision and
 * not that anything calls it.
 */
describe("REPL journey: a position earlier than the entry being read", () => {
  it("ER1: the invalid entry clears, and the draft, surface and position stand", function* () {
    const { page, root } = yield* mountJourney();
    const files = yield* histories(root);

    // Two entries, one after the other, through the one command. The second
    // is submitted without reopening anything, which is the Story's point.
    yield* submitted(page, "One.\n");
    yield* submitted(page, "Two.\n");
    const head = yield* projectionOf(root, files[0]);
    expect(head.entries.map((entry) => entry.key)).toEqual(["entry-1", "entry-2"]);

    // Standing on the second entry, with the next one already being typed.
    // A catalog row: opened to reach it, and the choice closes it again.
    yield* openCatalog(page);
    yield* page.focus("entry:entry-2");
    yield* page.key("Enter");
    yield* page.until("the catalog closing behind the choice", (frame) => !catalogOpen(frame));
    yield* draft(page).type("Three.");
    expect(draft(page).text()).toBe("Three.");

    // A position from before the second entry was ever admitted.
    yield* page.focus("footer:history");
    yield* page.key("Enter");
    yield* page.until("the History drawer", historyOpen);
    const markers = positions(page.frame());
    expect(markers.length).toBeGreaterThan(1);
    yield* page.focus(markers[0].key);
    yield* page.key("Enter");
    yield* page.until("a frozen position", historical);
    // The drawer is read through, so it is closed before the location is.
    yield* page.key("Escape");
    yield* page.until(
      "the drawer closing",
      (frame) => frame.area("box:drawer:layer") === undefined,
    );

    // The selection that prefix cannot hold is gone, and the position asked
    // for stands. Read from the catalog, which is where this screen keeps the
    // rows and their markers: the breadcrumb names whichever entry the
    // reading fell back to, which is a different question.
    yield* openCatalog(page);
    expect(readEntries(page.frame())).toEqual([]);
    yield* closeCatalog(page);
    expect(historical(page.frame())).toBe(true);

    // And the catalog is the one that prefix holds, rather than the head's.
    // Which entries the prefix holds, whatever they had settled to by then —
    // at this position the first one has not closed.
    yield* openCatalog(page);
    expect(shows(page.frame(), "] entry-1")).toBe(true);
    yield* closeCatalog(page);
    expect(shows(page.frame(), "] entry-2")).toBe(false);
    // The draft stands through all of it, on the row it is typed on.
    expect(draft(page).text()).toBe("Three.");

    yield* finish(page);
    const after = decodeLocation(exitRoute(page).location());
    expect(after.ok).toBe(true);
    if (after.ok) {
      // The entry that prefix never admitted is gone, and nothing was
      // guessed in its place.
      expect(after.value.scopes).toEqual([]);
      // The position is what was asked for, and it stands.
      expect(after.value.at).toBeDefined();
      expect(after.value.inspect).toBe(true);
      // So do the draft and the surface.
      expect(after.value.draft).toBe("Three.");
      expect(after.value.surface).toBe("entries");
    }
  });
});

describe("REPL journey: three entries, one command", () => {
  it("EJ1: a draft survives a refusal, inherits, fails, and is followed", function* () {
    const terminal = yield* scoped(function* (): Operation<Terminal> {
      const { page, root } = yield* mountJourney();
      const files = yield* histories(root);

      // 1. Entry 1, which publishes a value and then stops at its question.
      yield* submitted(page, JOURNEY_ONE);
      yield* openQuestion(page);
      yield* page.until("the drawer drawing decision: go", (frame) => shows(frame, "decision: go"));
      const held = yield* records(root, files[0]);
      expect(held.length).toBeGreaterThan(0);

      // 2. The next entry is drafted while that one is still running. The
      //    drawer owns focus while it is up, so it is dismissed first — the
      //    question stays open, which is what keeps Entry 1 live.
      yield* page.key("Escape");
      yield* page.until("the question's drawer closing", (frame) => !formShowing(frame));
      yield* paste(page, draft(page), JOURNEY_TWO);
      expect(draft(page).text().length).toBeGreaterThan(0);
      yield* page.key("Enter");

      // Refused, because Entry 1 has not finished. Nothing was admitted, the
      // history did not move, and the draft is exactly where it was.
      yield* page.until("the refusal", (frame) => shows(frame, "has not finished"));
      expect(yield* records(root, files[0])).toEqual(held);
      // The draft is exactly where it was, on the row it is typed on: the last
      // of its lines under a count of the rest.
      expect(draftShows(page, JOURNEY_TWO)).toBe(true);

      // 3. Answer the question, and Entry 1 settles.
      yield* page.focus("footer:asked");
      yield* page.key("Enter");
      yield* page.until("the drawer drawing decision: go", (frame) => shows(frame, "decision: go"));
      yield* form(page).value("decision").type("go");
      yield* page.key("Enter");
      yield* entrySettles(page, 1, "ok");
      expect(shows(page.frame(), "One: alpha/go")).toBe(true);

      // 4. The same draft, still carrying every character, becomes Entry 2.
      yield* page.focus("footer:input");
      const beforeTwo = railEntries(page.frame());
      yield* page.key("Enter");
      yield* page.until(
        "the draft becoming an entry",
        (frame) => draft(page).text() === "" && railEntries(frame) > beforeTwo,
      );
      yield* entrySettles(page, 2, "err");

      // It read what Entry 1 published, and it failed after publishing its own.
      const afterTwo = yield* projectionOf(root, files[0]);
      expect(afterTwo.entries.map((entry) => entry.key)).toEqual(["entry-1", "entry-2"]);
      expect(afterTwo.entries[1]?.source).toBe(JOURNEY_TWO);
      expect(afterTwo.entries[1]?.terminal?.status).toBe("err");
      expect(afterTwo.entries[1]?.bindings.find((binding) => binding.name === "seen")?.value).toBe(
        "alpha-two",
      );
      // Entry 1's own values are untouched by the failure beside them.
      expect(afterTwo.entries[0]?.bindings.find((binding) => binding.name === "token")?.value).toBe(
        "alpha",
      );

      // 5. Entry 3 follows the failure, and still reads Entry 1's value.
      yield* submitted(page, JOURNEY_THREE);
      yield* entrySettles(page, 3, "ok");
      // Read under its own entry. Answering Entry 1's question selected the entry
      // that was asking, and a selected entry is a transcript locus — so Entry 3's
      // output appears where Entry 3 is, which is what selecting it shows.
      // A catalog row: opened to reach it, and the choice closes it again.
      yield* openCatalog(page);
      yield* page.focus("entry:entry-3");
      yield* page.key("Enter");
      yield* page.until("the catalog closing behind the choice", (frame) => !catalogOpen(frame));
      yield* page.until("entry 3's own transcript", (frame) => shows(frame, "Three: alpha-three"));
      expect(shows(page.frame(), "Three: alpha-three")).toBe(true);

      // Three entries, in admission order, with the outcomes they reached —
      // which is not the order their outcomes would sort in.
      const settledModel = yield* projectionOf(root, files[0]);
      expect(settledModel.entries.map((entry) => entry.key)).toEqual([
        "entry-1",
        "entry-2",
        "entry-3",
      ]);
      expect(settledModel.entries.map((entry) => entry.terminal?.status)).toEqual([
        "ok",
        "err",
        "ok",
      ]);
      // The catalog's own rows, in its own spelling. Opened to read them,
      // because that is where this screen keeps the list.
      yield* openCatalog(page);
      for (const [at, outcome] of ["ok", "err", "ok"].entries()) {
        expect([
          at,
          page
            .frame()
            .control(`entry:entry-${at + 1}`)
            ?.text.includes(`${at + 1}. [${outcome}]`),
        ]).toEqual([at, true]);
      }

      // 6. The first entry is still selectable, and selecting it is a locus.
      yield* page.focus("entry:entry-1");
      yield* page.key("Enter");
      yield* page.until("the catalog closing behind the choice", (frame) => !catalogOpen(frame));
      yield* page.until("entry 1 being the locus", (frame) =>
        (selectedEntry(frame) ?? "").includes("Entry 1"),
      );
      expect(selectedEntry(page.frame())).toContain("Entry 1");
      yield* page.until("entry 1's own transcript", (frame) => shows(frame, "One: alpha/go"));
      expect(shows(page.frame(), "Three: alpha-three")).toBe(false);

      yield* finish(page);
      expect(exitRoute(page).location()).toBeDefined();
      return page.repl.terminal;
    });

    expect(terminal.resets).toBe(1);
  });
});

describe("REPL journey: what an open drawer covers, through the terminal", () => {
  it("TL6: narrow from the start, and through a resize round trip, it obscures what it covers", function* () {
    const { page } = yield* mountJourney({ size: NARROW });

    // A settled entry, so the body behind the drawer has a reading in it. A
    // narrow frame draws no transcript column, so what is behind the rectangle
    // there is the location and the catalog rather than the output — which is
    // why the rows covered are read off the screen rather than named here.
    yield* submitted(page, COLD_ONE);
    yield* entrySettles(page, 1, "ok");

    /**
     * What the drawer covers, and what it must leave alone, at this size.
     *
     * Both frames are whole screens: the one before the drawer went up and the
     * one with it open, so the cells inside the rectangle the drawer was placed
     * in are compared with what a person was looking at there.
     */
    function* covering(label: string): Operation<void> {
      // What a person is looking at before the drawer goes up, kept whole:
      // which of its rows the drawer covers is asked once it is there.
      const body = page.frame();

      yield* page.focus("footer:history");
      yield* page.key("Enter");
      yield* page.until(`the drawer at ${label}`, historyOpen);
      const open = page.frame();
      // The rectangle this frame actually placed it in.
      const layer = open.area("box:drawer:layer");
      if (layer === undefined) {
        throw new Error(`the drawer at ${label} placed no layer`);
      }
      const box = layer.bounds;
      // Pre-assert: the rectangle the drawer was placed in really had text in
      // it. Without this the assertion below would pass on an empty screen.
      const covered = body.within(box).rows().join("\n");
      expect(covered.trim().length).toBeGreaterThan(0);
      const inside = layer.rows().join("\n");
      // Its own rows are in the rectangle instead — including its heading, so
      // this is the drawer and not an empty hole.
      expect(inside).toContain("History");
      // And none of the lines it covered is anywhere inside it. Read as cells
      // rather than as descriptions: the blank interior of a short modal line
      // is exactly where a drawer without a background lets text through.
      // A window control the drawer offers *itself* cannot discriminate: both
      // panes spell `[^ earlier]` and `[v later]` the same way, so finding one
      // inside the rectangle says the drawer has its own, not that something
      // behind it showed through. Narrow routes one outlet holding the catalog
      // and the entry's reading, each with its own pair, so a fragment of one
      // of those labels is now among the covered lines.
      const shared = ["[↑ earlier]", "[↓ later]", "[close]"];
      for (const line of covered.split("\n").map((one) => one.trim())) {
        if (line.length < 4 || shared.some((control) => control.includes(line))) {
          continue;
        }
        expect([label, line, inside.includes(line)]).toEqual([label, line, false]);
      }
      // The footer is never covered. The drawer stops above all of it: the
      // compact History row, the directions below that, and the draft the
      // body keeps at its own foot are each still there to read, outside the
      // rectangle. The draft is not the frame's last row any more — that row
      // is the guidance — so each is asked for where it actually is.
      const bottom = box.y + box.height;
      expect(open.area("box:footer")?.bounds.y ?? -1).toBeGreaterThanOrEqual(bottom);
      expect(guidanceRow(open).trim().length).toBeGreaterThan(0);
      expect(open.control("footer:input")?.bounds.y ?? -1).toBeGreaterThanOrEqual(bottom);

      yield* page.key("Escape");
      yield* page.until(`the drawer closing at ${label}`, (frame) => !shows(frame, "[close]"));
    }

    // Narrow from the start, which is not the same screen as one that was
    // resized down to it.
    yield* covering("72x20");

    // Then a round trip, because a diffing renderer leaves stale text exactly
    // where a rectangle moved.
    yield* page.resize(WIDE);
    yield* covering("160x36");
    yield* page.resize(NARROW);
    yield* covering("72x20 again");

    yield* finish(page);
  });
});

describe("REPL journey: the Draft's Stop, through the terminal", () => {
  it("EL2: Draft Stop admits no successor until the stopped entry's cleanup joins", function* () {
    let entering = false;
    const release = withResolvers<void>();
    const terminal = yield* scoped(function* (): Operation<Terminal> {
      const hosted = yield* useJourneyHost();
      const root = hosted.root;
      // The execution's own teardown, held: the state where its close is written
      // and its task has not been joined.
      yield* Execution.around({
        *document([request], next): Operation<void> {
          yield* ensure(function* () {
            entering = true;
            yield* release.operation;
          });
          return yield* next(request);
        },
      });
      const page = yield* startJourney(hosted);
      // After the spawn, so it runs first: a failing row lets the held cleanup go.
      yield* ensure(() => release.resolve());
      const [file] = yield* histories(root);

      yield* submitted(page, STOPPED_ENTRY);
      yield* page.until("the entry asking, with what it printed", (frame) =>
        guidanceRow(frame).includes("Entry 1 waiting for an answer"),
      );
      yield* page.press("draft:stop");
      yield* awaited("the stopped entry's cleanup being entered", () => entering);

      // A successor asked for while cleanup is held is not admitted, and the
      // draft keeps it. The Tab after Enter is drawn only once Enter was read.
      yield* paste(page, draft(page), COLD_ONE);
      yield* page.key("Enter");
      yield* page.key("Tab");
      yield* page.until("the control after the Draft", (frame) => !draftFocused(frame));
      expect((yield* projectionOf(root, file)).entries.map((entry) => entry.key)).toEqual([
        "entry-1",
      ]);
      expect(draftShows(page, COLD_ONE)).toBe(true);

      release.resolve();
      yield* page.until("readiness for the successor", (frame) =>
        guidanceRow(frame).includes("Ready for Entry 2"),
      );
      yield* page.focus("footer:input");
      yield* page.key("Enter");
      yield* entrySettles(page, 2, "ok");

      // The history says what happened: one interruption that kept what it
      // printed, and exactly one successor.
      const model = yield* projectionOf(root, file);
      expect(model.entries.map((entry) => entry.terminal?.status)).toEqual(["cancelled", "ok"]);
      expect(
        model.entries[0]?.transcript.some(
          (row) => row.kind === "output" && row.text.includes("printed before the question"),
        ),
      ).toBe(true);
      expect(model.entries[0]?.scope.elicitations).toEqual([]);

      yield* finish(page);
      return page.repl.terminal;
    });
    expect(terminal.resets).toBe(1);
  });
});

/** The rail's own row, which is the band the footer keeps its History in. */
function bandOf(frame: PageFrame): string[] {
  return (frame.area("box:history")?.rows() ?? [])
    .filter((row) => row.includes(COMPACT_HISTORY_TITLE))
    .map((row) => row.trimEnd());
}

describe("REPL journey: a selection, a position and a draft across a resize", () => {
  it("TL10: every size and a refusal keep the nested reading, and a cold open restores it", function* () {
    const retained = yield* useTemporary("xmd-repl-journey-");

    /**
     * Whether the trail reads entry 2 and the component beneath it.
     *
     * The trail, because the catalog's selection channel marks the *entry* row
     * for every reading under it: a deeper scope is named by the breadcrumb and
     * by nothing else on this screen.
     */
    const nestedCrumb = (frame: PageFrame): boolean => {
      const trail = crumbTrail(frame);
      const entry = trail.indexOf("Entry 2");
      return entry !== -1 && trail.indexOf(SCOPE_NAME, entry) > entry;
    };

    const { files, standing } = yield* scoped(function* () {
      const { page } = yield* mountJourney({ root: retained, size: WIDE });
      const named = yield* histories(retained);
      yield* submitted(page, COLD_ONE);
      yield* entrySettles(page, 1, "ok");
      // The second entry invokes a component, so this execution retains a scope
      // beneath an entry — which is the reading this journey carries across
      // every size.
      yield* submitted(page, SCOPED_TWO);
      yield* entrySettles(page, 2, "ok");

      /** Point at one catalog row; the choice closes the catalog and selects it. */
      function* selecting(key: string, reaches: (one: PageFrame) => boolean): Operation<void> {
        yield* openCatalog(page);
        yield* page.press(key);
        yield* page.until(`${key} being the locus`, (one) => !catalogOpen(one) && reaches(one));
      }
      /** Whether the catalog marks this row as the one being read. */
      function* rowMarked(key: string, label: string): Operation<boolean> {
        yield* openCatalog(page);
        const text = page.frame().control(key)?.text;
        yield* closeCatalog(page);
        return text !== undefined && text.includes(label) && selectionMarked(text);
      }
      /**
       * What the catalog says about this reading, asked where its rows are.
       *
       * Three questions of one reading rather than three readings: the rows a
       * reader is looking at are one frame, and a fact taken from a later one
       * would be a fact about a different screen.
       */
      function* catalogued(): Operation<{
        readonly entry: boolean;
        readonly scope: boolean;
        readonly first: boolean;
      }> {
        yield* openCatalog(page);
        const now = page.frame();
        const entry = now.control("entry:entry-2")?.text ?? "";
        const read = {
          entry: entry.includes(READING) && selectionMarked(entry),
          scope: now.control("scope:entry-2/Checklist-1")?.text.includes(CATALOG_SCOPE) ?? false,
          first: now.control("entry:entry-1")?.text.includes("1. [ok] entry-1") ?? false,
        };
        yield* closeCatalog(page);
        return read;
      }

      // 1. An entry selected by pointing at the cell its catalog row is drawn in.
      yield* selecting("entry:entry-2", (one) => (selectedEntry(one) ?? "").includes("Entry 2"));
      expect(yield* rowMarked("entry:entry-2", "2. [ok] entry-2")).toBe(true);

      // 2. The position the component was admitted at, chosen in the drawer the
      //    footer control opens. That prefix is the one that holds the scope
      //    being read: a position taken at entry 2's own admission predates it.
      //    Choosing it leaves the drawer open, so it is dismissed and the
      //    position stands.
      yield* page.focus("footer:history");
      yield* page.key("Enter");
      yield* page.until("the History drawer", historyOpen);
      expect(shows(page.frame(), "[close]")).toBe(true);
      yield* page.focus(markerKey(page, CHECKPOINT));
      yield* page.key("Enter");
      yield* page.until("a frozen position", historical);
      yield* page.key("Escape");
      yield* page.until("the drawer closing", (one) => !shows(one, "[close]"));
      expect(historical(page.frame())).toBe(true);

      // 3. The component beneath that entry, selected by pointing at its own
      //    catalog row.
      yield* selecting("scope:entry-2/Checklist-1", nestedCrumb);
      expect(yield* catalogued()).toEqual({ entry: true, scope: true, first: true });

      // 4. A message, process-local, and a draft, each typed into its own field.
      yield* sidekick(page).composer.type(ASKED);
      yield* draft(page).type(DRAFTED);
      expect(nestedCrumb(page.frame())).toBe(true);
      expect(draftFocused(page.frame())).toBe(true);

      // 5. Medium and routed narrow: the same nested reading, position and
      //    draft, on a screen rebuilt for each size.
      for (const size of [MEDIUM, NARROW]) {
        const resized = yield* page.resize(size);
        expect(resized.rows.length).toBe(size.rows);
        expect(resized.rows.filter((line) => line.trimEnd().length > size.columns)).toEqual([]);
        expect(draft(page).text()).toBe(DRAFTED);
        expect([size.columns, nestedCrumb(resized), historical(resized)]).toEqual([
          size.columns,
          true,
          true,
        ]);
        expect(yield* catalogued()).toEqual({ entry: true, scope: true, first: true });
      }

      // 6. Below the minimum: one refusal, and no control drawn anywhere on it.
      const refused = yield* page.resize(BELOW_MINIMUM);
      expect(refused.keys()).toEqual([]);
      expect(refused.rows.filter((line) => /\[[^\]]*\]/.test(line))).toEqual([]);
      expect(refused.rows.some((line) => line.includes(SCOPE_NAME))).toBe(false);

      // 7. Wide again, and the reading is the one that went in, the message too.
      const wide = yield* page.resize(WIDE);
      expect(nestedCrumb(wide)).toBe(true);
      expect(historical(wide)).toBe(true);
      expect(draft(page).text()).toBe(DRAFTED);
      expect(sidekick(page).composer.text()).toContain(ASKED);
      expect(yield* catalogued()).toEqual({ entry: true, scope: true, first: true });

      // 8. The cells agree with the targets the frame published: pointing at
      //    entry 1's row selects it, and entry 2's puts the reading back. Both
      //    select an entry, which is a reading of the entry rather than of the
      //    component — so the component is pointed at again before leaving, and
      //    that is the reading the command publishes.
      yield* selecting("entry:entry-1", (one) => (selectedEntry(one) ?? "").includes("Entry 1"));
      expect(yield* rowMarked("entry:entry-1", "1. [ok] entry-1")).toBe(true);
      yield* selecting("entry:entry-2", (one) => !nestedCrumb(one));
      expect(yield* rowMarked("entry:entry-2", READING)).toBe(true);
      yield* selecting("scope:entry-2/Checklist-1", nestedCrumb);
      expect(draft(page).text()).toBe(DRAFTED);

      yield* finish(page);
      return { files: named, standing: exitRoute(page).location() };
    });

    // The whole reading, in the one string the command publishes on its way out:
    // route, surface, selected entry, the component beneath it, frozen position,
    // inspect and draft.
    expect(standing).toContain("/entry-2");
    expect(standing).toContain("at=");
    expect(standing).toContain("inspect");
    const stood = decodeLocation(standing);
    expect(stood.ok).toBe(true);
    if (stood.ok) {
      expect(stood.value.draft).toBe(DRAFTED);
      // Two members, the entry and the occurrence beneath it: an entry-only
      // route would describe a different reading from the one left on screen.
      expect(stood.value.scopes).toHaveLength(2);
      expect(stood.value.scopes[0]).toBe("entry-2");
      expect(standing).toContain(`/${stood.value.scopes[1]}`);
    }

    const path = yield* historyPath(retained, files[0]);
    const before = yield* until(readFile(path, "utf8"));

    // A cold process over that exact location: the same nested reading, with no
    // work performed and nothing appended.
    const { performed, second } = yield* scoped(function* () {
      const hosted = yield* useJourneyHost({ root: retained, reopening: true });
      const counted = yield* countPerformed();
      const page = yield* startJourney(hosted, { location: standing, size: WIDE });

      // Where a cold process puts the keyboard, asked before anything here has
      // opened a drawer over the reading: a drawer owns focus while it is up and
      // hands it back to the control that opened it, so this is the one moment
      // the question is about the process rather than about the catalog.
      expect(draftFocused(page.frame())).toBe(true);
      expect(draftShows(page, DRAFTED)).toBe(true);

      // The reading this location names, not the head: the component beneath
      // entry 2, at a position where entry 2 has settled nothing. The rows and
      // the marker while the catalog is the drawer up, because that is where
      // the rows are.
      expect(nestedCrumb(page.frame())).toBe(true);
      yield* openCatalog(page);
      const now = page.frame();
      expect(now.control("entry:entry-1")?.text).toContain("1. [ok] entry-1");
      expect(now.control("entry:entry-2")?.text).toContain(READING);
      expect(selectionMarked(now.control("entry:entry-2")?.text)).toBe(true);
      expect(now.control("scope:entry-2/Checklist-1")?.text).toContain(CATALOG_SCOPE);
      yield* closeCatalog(page);
      expect(draftShows(page, DRAFTED)).toBe(true);
      expect(nestedCrumb(page.frame())).toBe(true);
      expect(historical(page.frame())).toBe(true);

      yield* finish(page);
      // The same reading came back out of the cold process, byte for byte.
      expect(exitRoute(page).location()).toBe(standing);
      return { performed: counted, second: page.repl.terminal };
    });

    // No entry source compiled, no component source read, nobody asked.
    expect(performed.compiles).toBe(0);
    expect(performed.reads.filter((one) => one.endsWith(".md"))).toEqual([]);
    expect(performed.asked).toBe(0);
    // And the Journal is byte-identical: a cold process reads, it does not write.
    expect(yield* until(readFile(path, "utf8"))).toBe(before);
    expect(second.resets).toBe(1);
  });
});

describe("REPL journey: every recorded position, and every admitted size", () => {
  it("H5: the drawer reaches them all, and four resizes keep the reading", function* () {
    const terminal = yield* scoped(function* (): Operation<Terminal> {
      const { page, root } = yield* mountJourney({ size: WIDE });

      // Three entries, so the recorded order is longer than one drawer window:
      // reaching the end of it is then something the window controls have to do
      // rather than something the first frame already did.
      yield* submitted(page, COLD_ONE);
      yield* entrySettles(page, 1, "ok");
      yield* submitted(page, COLD_TWO);
      yield* entrySettles(page, 2, "ok");
      yield* submitted(page, COLD_THREE);
      yield* entrySettles(page, 3, "ok");
      yield* submitted(page, COLD_FOUR);
      yield* entrySettles(page, 4, "ok");

      const model = yield* projectionOf(root, (yield* histories(root))[0]);
      const expected = expectedRows(model);
      expect(expected.length).toBeGreaterThan(8);

      // 1. The exact set, in the recorded order, reached through `[↓ later]`.
      yield* page.focus("footer:history");
      yield* page.key("Enter");
      yield* page.until("the History drawer", historyOpen);
      expect(shows(page.frame(), "[close]")).toBe(true);
      // Wide enough to hold them all, so this is the whole exact set in one
      // window. That the window *controls* reach the rest of a set too long for
      // one is step 7's claim, at a size where it really is too long.
      expect((yield* drawerContent(page)).reached).toEqual(expected);

      // 2. What is visible holds focus, and the cell it is drawn in is its own
      //    target. Checked over the window as it stands, row by row, because a
      //    row drawn outside the rectangle the targets were published for is
      //    exactly the defect: visible, unfocusable, and answering a pointer
      //    with whatever is behind it.
      const window = positions(page.frame());
      // A walk over nothing would agree with every claim below it.
      expect(window.length).toBeGreaterThan(0);
      for (const row of window) {
        yield* page.focus(row.key);
        expect(page.frame().focused).toBe(row.key);
        expect([row.text, page.frame().area("box:drawer:layer")?.contains(row.key)]).toEqual([
          row.text,
          true,
        ]);
      }

      // 3. One of those rows, chosen by pointing at it, is the position it
      //    names and not the group the rail draws it in.
      const last = positions(page.frame()).at(-1);
      if (last === undefined) {
        throw new Error("the History drawer lists positions");
      }
      yield* page.press(last.key);
      yield* page.until("a frozen position", historical);
      yield* page.key("Escape");
      yield* page.until("the drawer closing", (one) => !shows(one, "[close]"));

      // 4. A whole reading to carry across the sizes: an entry selected, that
      //    position being read, and a draft nobody has submitted.
      // A catalog row: opened to point at it, and the choice closes it again.
      yield* openCatalog(page);
      yield* page.press("entry:entry-1");
      yield* page.until("the catalog closing behind the choice", (one) => !catalogOpen(one));
      yield* page.until("entry-1 being the locus", (one) =>
        (selectedEntry(one) ?? "").includes("Entry 1"),
      );
      yield* draft(page).type(DRAFTED);
      expect(historical(page.frame())).toBe(true);
      expect(draftFocused(page.frame())).toBe(true);
      const listed = bandOf(page.frame());
      expect(listed.some((row) => row.includes(COMPACT_HISTORY_TITLE))).toBe(true);

      // 5. The four sizes, in order. Each one is a profile: wide, medium,
      //    narrow, and a window too small to draw in at all.
      for (const size of [MEDIUM, NARROW, BELOW_MINIMUM]) {
        const shown = yield* page.resize(size);
        // Nothing drawn past the window's own edge, at any of them.
        expect(shown.rows.filter((line) => line.trimEnd().length > size.columns)).toEqual([]);
        if (size.columns < NARROW.columns || size.rows < NARROW.rows) {
          // Too small to draw in: the refusal and nothing else, which is the
          // admission rule rather than a reading of this state.
          expect(shows(shown, "Make the window larger")).toBe(true);
          continue;
        }
        // At a size it can draw at, the reading is the one that went in. The
        // marked row is in the catalog, which is a drawer over the reading at
        // every size this screen draws — so it is opened for the row and put
        // away again, and the reader goes back to the draft they were typing
        // in, which is where the rest of this row looks for them.
        expect(shown.has("footer:input")).toBe(true);
        expect(shows(shown, DRAFTED)).toBe(true);
        yield* openCatalog(page);
        expect(selectionMarked(page.frame().control("entry:entry-1")?.text)).toBe(true);
        yield* closeCatalog(page);
        yield* page.focus("footer:input");
      }

      // 6. Wide again. The marker, the route, the draft and the focus are the
      //    ones the reader left, after a screen taken apart four times.
      const back = yield* page.resize(WIDE);
      expect(back.rows.length).toBe(WIDE.rows);
      expect(selectedEntry(back)).toContain("Entry 1");
      expect(historical(back)).toBe(true);
      expect(draft(page).text()).toBe(DRAFTED);
      expect(draftFocused(back)).toBe(true);
      // And the band is the band that went in: the same rail, mark for mark.
      expect(bandOf(back)).toEqual(listed);

      // 7. Narrow, where the recorded order is longer than the window: the rest
      //    of it is reached through `[↓ later]`, and the set is the same one.
      //    The resize is not allowed to have cost a position either.
      yield* page.resize(NARROW);
      yield* page.focus("footer:history");
      yield* page.key("Enter");
      yield* page.until("the History drawer", historyOpen);
      const narrow = yield* drawerContent(page);
      expect(narrow.reached).toEqual(expected);
      // The control did the reaching: one window held less than the whole set.
      expect(narrow.first.length).toBeLessThan(expected.length);

      page.repl.terminal.end();
      const outcome = yield* returned(page);
      expect(outcome.refusal).toBeUndefined();
      return page.repl.terminal;
    });

    expect(terminal.resets).toBe(1);
  });
});

describe("REPL journey: a cold process at an early position", () => {
  it("H6: the settled head, the prefix, the same rail, and no work at all", function* () {
    const retained = yield* useTemporary("xmd-repl-journey-");
    const sizes = [WIDE, MEDIUM, NARROW];

    // A hot process: two entries, a position early in the recorded order, a
    // draft, and a History drawer scrolled away from its first row.
    const { files, standing, expected, hot } = yield* scoped(function* () {
      const { page } = yield* mountJourney({ root: retained, size: WIDE });
      const named = yield* histories(retained);

      // Four entries, so the first position is early in a long recorded order
      // and that order is longer than a narrow drawer's window.
      yield* submitted(page, COLD_ONE);
      yield* entrySettles(page, 1, "ok");
      yield* submitted(page, COLD_TWO);
      yield* entrySettles(page, 2, "ok");
      yield* submitted(page, COLD_THREE);
      yield* entrySettles(page, 3, "ok");
      yield* submitted(page, COLD_FOUR);
      yield* entrySettles(page, 4, "ok");
      const rows = expectedRows(yield* projectionOf(retained, named[0]));

      // The first position in the recorded order: entry 1's own admission, which
      // the whole of entry 2 comes after.
      yield* page.focus("footer:history");
      yield* page.key("Enter");
      yield* page.until("the History drawer", historyOpen);
      const first = positions(page.frame())[0];
      expect(first?.text).toBe(rows[0]);
      yield* page.focus(first.key);
      yield* page.key("Enter");
      yield* page.until("a frozen position", historical);
      yield* page.key("Escape");
      yield* page.until("the drawer closing", (one) => !shows(one, "[close]"));

      yield* draft(page).type(DRAFTED);

      // The rail this reading draws, at each size, read from that size's frames.
      const bands: string[][] = [];
      for (const size of sizes) {
        bands.push(bandOf(yield* frameAt(page, size)));
      }
      // Rails with marks on them, so the comparison in the cold process below
      // is between two drawn rails rather than between two sets of blank rows.
      // The compact rail marks an entry with the state the prefix being read
      // holds it in, written as the first character of that state's own word —
      // a glyph where the word has one and a letter where it does not. An entry
      // the read prefix does not reach carries its number alone, which is why
      // this asks for one marked entry rather than for all of them. The
      // five-row rail's own position glyphs belong to the band this replaced.
      for (const band of bands) {
        expect(band.some((row) => row.includes("\u2500"))).toBe(true);
        expect(band.some((row) => /\s\d+ \S/.test(row))).toBe(true);
      }
      // Back to the size the cold process will open at, so the comparison below
      // is between two processes and not between two sizes.
      yield* frameAt(page, sizes[0]);

      // And the drawer scrolled off its first row before this process leaves, so
      // none of where it was looking is in what it leaves behind: the location
      // names a position and a draft and says nothing about a window over a
      // list. Scrolled at the narrow size, which is where the recorded order is
      // longer than the window that shows it.
      yield* frameAt(page, NARROW);
      yield* page.focus("footer:history");
      yield* page.key("Enter");
      yield* page.until("the History drawer", historyOpen);
      const walked = yield* drawerContent(page);
      expect(walked.reached).toEqual(rows);
      expect(drawerRows(page.frame())[0]).not.toBe(rows[0]);
      yield* page.key("Escape");
      yield* page.until("the drawer closing", (one) => !shows(one, "[close]"));

      yield* finish(page);
      return { files: named, standing: exitRoute(page).location(), expected: rows, hot: bands };
    });

    // What the location names: the early position and the draft, and nothing
    // about how anything was being looked at.
    const stood = decodeLocation(standing);
    expect(stood.ok).toBe(true);
    if (stood.ok) {
      expect(stood.value.draft).toBe(DRAFTED);
      expect(stood.value.at).toBeDefined();
    }
    const path = yield* historyPath(retained, files[0]);
    const before = yield* until(readFile(path, "utf8"));
    const retainedFiles = yield* histories(retained);

    const { performed, second } = yield* scoped(function* () {
      const hosted = yield* useJourneyHost({ root: retained, reopening: true });
      const counted = yield* countPerformed();
      const page = yield* startJourney(hosted, { location: standing, size: WIDE });

      // 1. A settled head. Nothing is running in this process and nothing ever
      //    will, so the band says the execution is down — not live, and not a
      //    state inherited from the process that recorded it.
      expect(bandOf(page.frame()).some((row) => row.includes("HEAD \u00b7 SETTLED"))).toBe(true);
      for (const live of [
        "HEAD \u00b7 LIVE",
        "HEAD \u00b7 SETTLING",
        "HEAD \u00b7 EXPANSION PAUSED",
      ]) {
        expect([live, bandOf(page.frame()).some((row) => row.includes(live))]).toEqual([
          live,
          false,
        ]);
      }

      // 2. The prefix this location names: entry 1 is there, and entry 2 — which
      //    the whole of this position predates — is not.
      // Read in the catalog, which is where this screen keeps those rows: it is
      // a drawer over the reading, so it is opened for them and put away again.
      yield* openCatalog(page);
      expect(shows(page.frame(), "1. [")).toBe(true);
      expect(shows(page.frame(), "2. [")).toBe(false);
      yield* closeCatalog(page);
      expect(historical(page.frame())).toBe(true);
      expect(draft(page).text()).toBe(DRAFTED);

      // 3. No badge of a live process on it: nothing to pause, nothing
      //    streaming, nothing to continue.
      for (const badge of ["[pause]", "[continue]"]) {
        expect([badge, shows(page.frame(), badge)]).toEqual([badge, false]);
      }
      expect(page.frame().rows.some((line) => line.trim().startsWith("\u2026"))).toBe(false);

      // 4. The same rail, mark for mark, at each of the same sizes: navigation
      //    is the whole recorded file, so a process that holds one prefix of it
      //    draws what the process that recorded all of it drew.
      const cold: string[][] = [];
      for (const size of sizes) {
        cold.push(bandOf(yield* frameAt(page, size)));
      }
      expect(cold).toEqual(hot);
      yield* frameAt(page, sizes[0]);

      // 5. The same positions, by category and order, with nothing of a payload
      //    in any of them. And the window opens on the first one: the process
      //    that recorded this left its own scrolled to the end, and where it was
      //    looking is not part of the reading it handed on.
      expect(shows(page.frame(), "[close]")).toBe(false);
      yield* page.focus("footer:history");
      yield* page.key("Enter");
      yield* page.until("the History drawer", historyOpen);
      expect(drawerRows(page.frame())[0]).toBe(expected[0]);
      const walked = yield* drawerContent(page);
      expect(walked.reached).toEqual(expected);
      yield* page.key("Escape");
      yield* page.until("the drawer closing", (one) => !shows(one, "[close]"));

      yield* finish(page);
      // The same reading went back out, which is what makes the claims above
      // about this process's reading rather than about a frame it drew once.
      expect(exitRoute(page).location()).toBe(standing);
      return { performed: counted, second: page.repl.terminal };
    });

    // 6. No work was performed to produce any of it: nothing compiled, no
    //    component source read, nobody asked.
    expect(performed.compiles).toBe(0);
    expect(performed.reads.filter((one) => one.endsWith(".md"))).toEqual([]);
    expect(performed.asked).toBe(0);
    // And nothing was written: the same files, byte for byte.
    expect(yield* histories(retained)).toEqual(retainedFiles);
    expect(yield* until(readFile(path, "utf8"))).toBe(before);
    expect(second.resets).toBe(1);
  });
});

describe("REPL journey: a cold process over a multi-entry journal", () => {
  it("EC1: the same catalog and the same selected entry, with no work and no append", function* () {
    const retained = yield* useTemporary("xmd-repl-journey-");

    // Two entries through one command, and then the process is over.
    const { files, first } = yield* scoped(function* () {
      const { page } = yield* mountJourney({ root: retained });
      const named = yield* histories(retained);

      yield* submitted(page, COLD_ONE);
      yield* entrySettles(page, 1, "ok");
      yield* submitted(page, COLD_TWO);
      yield* entrySettles(page, 2, "ok");
      expect(shows(page.frame(), "Two: alpha-again")).toBe(true);

      yield* finish(page);
      return { files: named, first: page.repl.terminal };
    });
    expect(first.resets).toBe(1);
    expect(first.readers).toBe(0);

    const path = yield* historyPath(retained, files[0]);
    const before = yield* until(readFile(path, "utf8"));
    const execution = files[0].replace(/\.jsonl$/, "");

    const live = yield* projectionOf(retained, files[0]);
    expect(live.entries.map((entry) => entry.key)).toEqual(["entry-1", "entry-2"]);

    // A location that names the *second* entry, so what comes back has to be a
    // catalog and a selection rather than whatever happens to be first.
    const location = encodeLocation({
      execution,
      surface: "entries",
      scopes: ["entry-2"],
      drawers: [],
      at: undefined,
      inspect: false,
      draft: undefined,
      session: undefined,
      view: undefined,
      right: undefined,
      sidekick: undefined,
    });

    const { performed, second } = yield* scoped(function* () {
      const hosted = yield* useJourneyHost({ root: retained, reopening: true });
      const counted = yield* countPerformed();
      const page = yield* startJourney(hosted, { location });

      // Both entries, in admission order, with the outcomes the file holds —
      // and the one the location named is the locus.
      // Read in the catalog, which is where this screen keeps the rows.
      yield* openCatalog(page);
      expect(page.frame().control("entry:entry-1")?.text).toContain("1. [ok] entry-1");
      expect(page.frame().control("entry:entry-2")?.text).toContain("2. [ok] entry-2");
      yield* closeCatalog(page);
      expect(selectedEntry(page.frame())).toContain("Entry 2");
      expect(shows(page.frame(), "Two: alpha-again")).toBe(true);
      // Entry 2's locus, not the whole execution's: the first entry's output
      // belongs to the row above, and selecting one is selecting a transcript.
      expect(shows(page.frame(), "One: alpha")).toBe(false);

      // The value the first entry published is still what the second inherited,
      // read back from the file rather than from anything this process ran.
      const cold = yield* projectionOf(retained, files[0]);
      expect(cold.entries[1]?.bindings.find((binding) => binding.name === "carried")?.value).toBe(
        "alpha-again",
      );

      yield* finish(page);
      return { performed: counted, second: page.repl.terminal };
    });

    // Nothing was performed to do it: no entry source compiled, no component
    // source read, and no provider reached.
    expect(performed.compiles).toBe(0);
    expect(performed.reads.filter((one) => one.endsWith(".md"))).toEqual([]);
    // And the file is the file. A cold process reads; it does not append.
    expect(yield* until(readFile(path, "utf8"))).toBe(before);
    expect(second.resets).toBe(1);
  });
});

/**
 * What one interaction costs in terminal size reads, through the real loop.
 *
 * The root reads the size at the too-small check, again to resolve the frame,
 * again for the measurement the frame is built from, and again to revalidate
 * it. A fifth read appears the moment an action is answered with a freshly
 * measured frame — which is what the gate exists to avoid for a keystroke.
 * The recording terminal counts those reads, so this is the production
 * dispatch, preparation and reconciliation path observed from outside.
 */
function* costOf(page: ReplPage, send: () => Operation<void>): Operation<number> {
  const from = page.repl.terminal.sized;
  const index = page.frame().index;
  yield* send();
  yield* page.until("a frame presented for it", (frame) => frame.index > index);
  return page.repl.terminal.sized - from;
}

describe("REPL responsiveness: an interaction beside a long reading", () => {
  for (const lines of [12, 222]) {
    it(`RS3: typing and traversing beside a ${lines}-line entry read the size a fixed number of times`, function* () {
      const { page } = yield* mountJourney();

      // Input is read in order, so the Enter is taken after every pasted line.
      const before = railEntries(page.frame());
      yield* page.focus("footer:input");
      page.repl.terminal.bytes(new TextEncoder().encode(longEntry(lines)));
      yield* page.key("Enter");
      yield* page.until(
        "the draft becoming an entry",
        (frame) => draft(page).text() === "" && railEntries(frame) > before,
      );
      yield* entrySettles(page, 1, "ok");
      yield* page.until("the draft offering Send again", (frame) => frame.has("draft:send"));
      // The long reading is the selected one, so it is what a frame would
      // have to fit if anything made it fit again.
      // A catalog row: opened to point at it, and the choice closes it again.
      yield* openCatalog(page);
      yield* page.press("entry:entry-1");
      yield* page.until("the catalog closing behind the choice", (one) => !catalogOpen(one));
      yield* page.focus("footer:input");

      // Warmup: the first keystroke after a selection still measures the
      // reading once, because this is the first frame that reading is in.
      yield* costOf(page, () => page.type("a"));

      const typed = [
        yield* costOf(page, () => page.type("b")),
        yield* costOf(page, () => page.type("c")),
      ];
      const erased = yield* costOf(page, () => page.key("Backspace"));
      const forward = yield* costOf(page, () => page.key("Tab"));
      const backward = yield* costOf(page, () => page.key("Backtab"));

      // Four reads each: the too-small check, the resolution, the frame's
      // measurement and its revalidation. A fifth would be an action
      // answered with a frame measured before it ran — which a keystroke
      // does not need, and which is what this count is here to catch.
      expect([lines, typed]).toEqual([lines, [4, 4]]);
      expect([lines, erased]).toEqual([lines, 4]);
      // A traversal is answered by the tree, not the reducer, so it reads
      // the size for its one frame and nothing else.
      expect([lines, forward]).toEqual([lines, 4]);
      expect([lines, backward]).toEqual([lines, 4]);

      yield* finish(page);
    });
  }
});

describe("REPL responsiveness: a focus move is one frame", () => {
  it("RS1: Tab moves the cue and the focus, and presents once", function* () {
    const { page } = yield* mountJourney();
    const { terminal } = page.repl;

    // Something to traverse, and a settled screen to count from.
    yield* submitted(page, COLD_ONE);
    yield* entrySettles(page, 1, "ok");
    yield* page.until("the draft offering Send again", (frame) => frame.has("draft:send"));
    yield* page.focus("footer:input");

    // Where focus is now, as the frame reports it.
    const before = page.frame().focused;
    expect(before).toBe("footer:input");

    const from = terminal.presented.length;
    yield* page.key("Tab");
    yield* page.until("focus leaving the draft", (frame) => frame.focused !== before);

    // The focus moved, so the traversal happened.
    expect(page.frame().focused).not.toBe(before);
    // And it cost one frame. It used to cost two: the first drew the control
    // the reader had just left and the second corrected it, so the marker was
    // always one keystroke behind what the tree already held.
    expect(terminal.presented.length - from).toBe(1);

    // Back again, the same way and for the same price.
    const back = terminal.presented.length;
    yield* page.key("Backtab");
    yield* page.until("focus returning to the draft", (frame) => frame.focused === before);
    expect(terminal.presented.length - back).toBe(1);

    yield* finish(page);
  });
});

describe("REPL first use: UI2", () => {
  it("UI2: Enter on [exit] ends the command without touching the history", function* () {
    const root = yield* useTemporary("xmd-repl-journey-");
    const { terminal, outcome } = yield* scoped(function* () {
      const { page } = yield* mountJourney({ root });

      const files = yield* histories(root);
      const before = yield* until(readFile(yield* historyPath(root, files[0]), "utf8"));

      // Reached by traversal, from what the screen shows: no hidden key, and the
      // control says what it is.
      yield* page.focus("footer:exit");
      expect(page.frame().focused).toBe("footer:exit");
      yield* page.key("Enter");

      // The command is over. Joined rather than polled: the scope the program owns
      // holds the session, the observer, the reader and the frame subscription,
      // and this returns only once every one of them has been halted and joined.
      const returnedOutcome = yield* returned(page);

      // Nothing was appended for leaving. Leaving is the absence of further work,
      // not an outcome, so the file is byte-identical.
      expect(yield* until(readFile(yield* historyPath(root, files[0]), "utf8"))).toBe(before);
      return { terminal: page.repl.terminal, outcome: returnedOutcome };
    });

    // Ordinary success, with a location to come back to, and the terminal given
    // back exactly once.
    expect(outcome.refusal).toBeUndefined();
    expect(outcome.location).toContain("xmd://repl/");
    expect(terminal.resets).toBe(1);
    expect(terminal.readers).toBe(0);
  });
});

describe("REPL first use: UI2", () => {
  it("UI2: a pointer on [exit] is the same act as Enter on it", function* () {
    const { terminal, outcome } = yield* scoped(function* () {
      const { page } = yield* mountJourney();

      // No traversal at all: a pointer resolves against the drawn frame, so this
      // reaches the control exactly where the screen draws it.
      yield* page.press("footer:exit");
      return { terminal: page.repl.terminal, outcome: yield* returned(page) };
    });

    expect(outcome.refusal).toBeUndefined();
    expect(outcome.location).toContain("xmd://repl/");
    expect(terminal.resets).toBe(1);
  });
});

describe("REPL first use: UI1", () => {
  it("UI1: the guidance teaches the ring that is mounted, at both sizes", function* () {
    for (const size of [WIDE, NARROW]) {
      yield* scoped(function* (): Operation<void> {
        const { page } = yield* mountJourney({ size });

        // Focus starts on the draft, and what the screen says is what Enter there
        // does. Not a legend: the words change with the control under the cursor.
        expect(shows(page.frame(), "Type here")).toBe(true);
        expect(shows(page.frame(), "Enter submits")).toBe(true);
        expect(says(page.frame(), "box:guidance", "Tab/Shift+Tab move")).toBe(true);
        // And the state it says that about, which is what makes "Enter submits"
        // a fact rather than a legend (#870 UI10).
        expect(shows(page.frame(), "Ready for Entry 1")).toBe(true);
        // Escape closes a drawer, and there is no drawer. A legend naming it here
        // would advertise an action nothing mounts.
        expect(shows(page.frame(), "Esc closes")).toBe(false);

        // Both ways out of the draft. Enter does not submit from a control, at
        // either size, and the row says so by not saying otherwise.
        yield* page.focus("footer:exit");
        expect(shows(page.frame(), "Enter submits")).toBe(false);
        // What Enter does on this node, rather than what it does on controls in
        // general: `[exit]` leaves the command (#870 UI16).
        expect(shows(page.frame(), "Enter exits")).toBe(true);
        // The state survives moving focus, which is the whole point of putting it
        // first: it is the one fact a person cannot work out from the keys.
        expect(shows(page.frame(), "Ready for Entry 1")).toBe(true);
        // Both say what Enter does and both say how to get back to the draft.
        // The narrow row says each in fewer columns, because it is composed to
        // fit 72 rather than written once and cut (#870 UI10/UI16): pointer
        // equivalence and the longer way of saying "Tab to the draft" are what
        // the extra columns of a wide frame buy.
        if (size.columns > NARROW.columns) {
          expect(says(page.frame(), "box:guidance", "Tab to the draft to type")).toBe(true);
        } else {
          expect(shows(page.frame(), "Tab to draft")).toBe(true);
        }
        // The generic spelling, on a control with nothing particular to say.
        yield* toTranscript(page);
        expect(
          shows(
            page.frame(),
            size.columns > NARROW.columns ? "Enter or click activates" : "Enter activates",
          ),
        ).toBe(true);

        // With a drawer up, Escape is a thing that does something, and it says so.
        yield* page.focus("footer:history");
        yield* page.key("Enter");
        yield* page.until("the History drawer", (frame) => shows(frame, "[close]"));
        expect(shows(page.frame(), "Esc closes")).toBe(true);

        yield* finish(page);
      });
    }
  });
});

describe("REPL first use: UI1/UI5", () => {
  it("UI1/UI5: the footer holds the actions, the band and the draft, in that order", function* () {
    const { page, root } = yield* mountJourney({ size: NARROW });

    // Something for the band to hold, so its rows are rows with text in them.
    yield* submitted(page, COLD_ONE);
    yield* entrySettles(page, 1, "ok");
    const model = yield* projectionOf(root, (yield* histories(root))[0]);
    expect(model.checkpoints.length).toBeGreaterThan(0);

    const frame = page.frame();
    const rows = frame.rows;
    // The row the footer controls are placed on, found by the way out's own
    // placement rather than counted back from the frame's height: the footer
    // is a compact History row and one guidance row now, not seven.
    const exit = frame.control("footer:exit");
    expect(exit).toBeDefined();
    const actions = exit?.bounds.y ?? -1;

    // One action row, and every control is on it.
    expect(rows[actions]).toContain("[history]");
    expect(rows[actions]).toContain("[exit]");
    // The rail shares that row: its title, its rule and a mark per position.
    // It used to take five rows of its own below the controls; the compact
    // row says the same things in one, and what it says is `repl-history`'s.
    const band = [rows[actions]];
    // Re-anchored for #881 PR 3: the band listed checkpoint *labels* and now
    // draws a measured rail — its title, its rule and a mark per position.
    // What this case is about is the footer's order, and the band being
    // there is what it needs; what the band says is `repl-history`'s.
    expect(band.some((row) => row.includes(COMPACT_HISTORY_TITLE))).toBe(true);
    expect(band.some((row) => row.includes("─"))).toBe(true);
    // The draft is in the selected work's own body, which is where the thing
    // it is the draft *of* is — not on the last row of the terminal, which
    // this screen gives to its guidance.
    expect(rows[rows.length - 1]).toContain("Tab/Shift+Tab");
    expect(draftFocused(frame)).toBe(true);
    expect(frame.control("footer:input")?.bounds.y ?? rows.length).toBeLessThan(actions);

    // And nothing of the band at the top of the screen, which is where it used
    // to be drawn: the first row belongs to whatever the body put there.
    for (const checkpoint of model.checkpoints) {
      expect([checkpoint.label, rows[0].includes(checkpoint.label)]).toEqual([
        checkpoint.label,
        false,
      ]);
    }

    yield* finish(page);
  });
});

describe("REPL first use: UI9", () => {
  it("UI9: typing at a control never reaches the draft, and the screen says why", function* () {
    const { page } = yield* mountJourney();

    // Something in the draft first, so "unchanged" is a claim about bytes rather
    // than about emptiness.
    yield* draft(page).type("the draft");
    const before = draft(page).text();
    expect(before).toBe("the draft");

    yield* page.focus("footer:exit");
    // The explanation is on the screen *before* the keystroke that needs it.
    expect(says(page.frame(), "box:guidance", "Tab to the draft to type")).toBe(true);

    yield* page.type("xyz");
    yield* lingering();
    // Byte for byte: a control that let text fall through to the draft would be
    // editing a field nobody is looking at.
    expect(draft(page).text()).toBe(before);
    expect(shows(page.frame(), "xyz")).toBe(false);

    // And the draft takes them again as soon as focus comes back to it.
    yield* draft(page).type("more");
    expect(draft(page).text()).not.toBe(before);
    expect(shows(page.frame(), "the draftmore")).toBe(true);

    yield* finish(page);
  });
});

describe("REPL first use: UI2 too small", () => {
  it("UI2: below the minimum there is no exit to aim at, and Escape leaves", function* () {
    const TINY = { columns: 60, rows: 18 };

    // The semantic tree first: at a size this REPL cannot draw at, the control is
    // not described — so there is nothing to reconcile, nothing to focus and
    // nothing a pointer could be answered with. At a size it can draw at, it is.
    const tiny = describeApplication(
      refusedView(initialState("tiny"), "this history cannot be read.", TINY),
      measuringContext(TINY),
    ).map((one) => readDescription(one).key);
    expect(tiny).not.toContain("footer:exit");
    const roomy = describeApplication(
      refusedView(initialState("tiny"), "this history cannot be read.", WIDE),
      measuringContext(WIDE),
    ).map((one) => readDescription(one).key);
    expect(roomy).toContain("footer:exit");

    // And then the real command, in a window that size.
    const { terminal, outcome } = yield* scoped(function* () {
      const { page } = yield* mountJourney({ size: TINY });

      // The one screen with no control on it says both of the things it can:
      // that growing the window recovers, and that Escape leaves.
      expect(shows(page.frame(), "60x18")).toBe(true);
      expect(shows(page.frame(), "larger")).toBe(true);
      expect(shows(page.frame(), "Escape")).toBe(true);
      // Nothing to aim at: no control is drawn, so none is in the target map.
      expect(page.frame().keys()).toEqual([]);
      expect(shows(page.frame(), "[exit]")).toBe(false);
      expect(shows(page.frame(), "[history]")).toBe(false);

      // Enter does nothing. The command is still running afterwards, which is the
      // whole of what "no hidden exit target" means here.
      yield* page.key("Enter");
      yield* lingering();
      expect(page.repl.outcome()).toBeUndefined();
      expect(page.repl.terminal.resets).toBe(0);

      // Escape is the way out, and it is the same structured teardown.
      yield* page.key("Escape");
      return { terminal: page.repl.terminal, outcome: yield* returned(page) };
    });

    expect(outcome.location).toContain("xmd://repl/");
    expect(terminal.resets).toBe(1);
    expect(terminal.readers).toBe(0);
  });
});

describe("REPL first use: UI3", () => {
  it("UI3: a question on Sessions moves nothing, and is reached by activating it", function* () {
    const { page } = yield* mountJourney();

    // On Sessions, with something typed, before anything is asked.
    yield* toTranscript(page);
    yield* submitted(page, JOURNEY_ONE);
    expect(surfaceRouted(page.frame(), "Sessions")).toBe(true);
    yield* page.focus("footer:exit");
    const standing = page.frame().rows;

    // The question arrives. It announces itself and does nothing else: the
    // surface, the focused control and the whole screen are where they were,
    // apart from the announcement itself.
    yield* page.until("the waiting question", asked);
    expect(surfaceRouted(page.frame(), "Sessions")).toBe(true);
    expect(page.frame().focused).toBe("footer:exit");
    expect(shows(page.frame(), "decision: go")).toBe(false);
    expect(standing.length).toBeGreaterThan(0);

    // Activating it is what opens it, and that act crosses to the surface the
    // question belongs to and selects the entry that is asking.
    yield* page.press("footer:asked");
    yield* page.until("the question's form", (frame) => shows(frame, "decision: go"));
    // Activating it crossed to the surface the question belongs to, and
    // selected the entry that is asking.
    expect(surfaceRouted(page.frame(), "Entries")).toBe(true);
    expect(selectedEntry(page.frame())).toContain("Entry 1");

    // Escape dismisses without answering, and the question is still waiting — so
    // it announces itself again and opens again.
    yield* page.key("Escape");
    yield* page.until("the drawer closing", (frame) => !shows(frame, "decision: go"));
    yield* openQuestion(page);
    expect(shows(page.frame(), "decision: go")).toBe(true);

    yield* finish(page);
  });
});

describe("REPL first use: UI1 selection", () => {
  it("UI1: the active surface and the selected entry are marked in the frame", function* () {
    for (const size of [WIDE, NARROW]) {
      yield* scoped(function* (): Operation<void> {
        const { page } = yield* mountJourney({ size });

        yield* submitted(page, COLD_ONE);
        yield* entrySettles(page, 1, "ok");
        yield* submitted(page, COLD_TWO);
        yield* entrySettles(page, 2, "ok");

        // Entries is where the route starts, and the frame says so. At a shared
        // width it says it in the selected work's own breadcrumb — the routed
        // surface bar belongs to the narrow frame, which routes one outlet.
        expect(surfaceRouted(page.frame(), "Entries")).toBe(true);
        expect(selectedEntry(page.frame())).toBeDefined();

        // Switching surfaces changes cells that are not the location: the URL
        // alone cannot satisfy this, because the location rows are excluded.
        const onEntries = page.frame().rows;
        yield* toTranscript(page);
        const onSessions = page.frame().rows;
        expect(onSessions).not.toEqual(onEntries);
        expect(surfaceRouted(page.frame(), "Sessions")).toBe(true);

        // By pointer too, and it means the same thing: the marker comes back to
        // Entries and the screen is no longer the Sessions one. Not byte-identical
        // to `onEntries`, because activating by pointer also moves focus there —
        // which is the other marker, and the point of their being two.
        yield* page.press("entries:heading");
        yield* page.until(
          "the Entries surface routed",
          (frame) => catalogOpen(frame) && surfaceRouted(frame, "Entries"),
        );
        expect(surfaceRouted(page.frame(), "Entries")).toBe(true);
        expect(page.frame().rows).not.toEqual(onSessions);

        // Selecting one entry versus the other moves one marker and no other.
        // A catalog row: opened to reach it, and the choice closes it again.
        yield* openCatalog(page);
        yield* page.focus("entry:entry-1");
        yield* page.key("Enter");
        yield* page.until("the catalog closing behind the choice", (one) => !catalogOpen(one));
        // The marker is in the catalog, which is where the rows are: reopened
        // to read it, and put away again so the reading below is the reading.
        yield* openCatalog(page);
        expect(selectionMarked(page.frame().control("entry:entry-1")?.text)).toBe(true);
        expect(selectionMarked(page.frame().control("entry:entry-2")?.text)).toBe(false);
        yield* closeCatalog(page);
        const readingFirst = page.frame().rows;

        // A catalog row: opened to reach it, and the choice closes it again.
        yield* openCatalog(page);
        yield* page.focus("entry:entry-2");
        yield* page.key("Enter");
        yield* page.until("the catalog closing behind the choice", (one) => !catalogOpen(one));
        yield* openCatalog(page);
        expect(selectionMarked(page.frame().control("entry:entry-2")?.text)).toBe(true);
        expect(selectionMarked(page.frame().control("entry:entry-1")?.text)).toBe(false);
        yield* closeCatalog(page);
        expect(page.frame().rows).not.toEqual(readingFirst);

        // And the marker is the route's, not focus's: it stays where it is when
        // focus goes somewhere else entirely.
        yield* page.focus("footer:exit");
        expect(page.frame().focused).toBe("footer:exit");
        expect(surfaceRouted(page.frame(), "Entries")).toBe(true);
        // Still that entry's, with focus elsewhere entirely: the marker is the
        // route's rather than focus's, and reopening the catalog shows it.
        yield* openCatalog(page);
        expect(selectionMarked(page.frame().control("entry:entry-2")?.text)).toBe(true);
        yield* closeCatalog(page);

        // Selecting an entry does not filter the agent work this execution has.
        // Both sections are still there and still say they hold none.
        yield* toTranscript(page);
        // One list across both owners since the single-list correction, so an
        // execution that has done no agent work says so once. The two owners
        // keep their separate domains; what changed is how the screen reads
        // them.
        expect(shows(page.frame(), "(none retained)")).toBe(true);

        yield* finish(page);
      });
    }
  });
});

/**
 * The narrow guidance row is composed, not cut (#870 UI10/UI16).
 *
 * Asserted by exact equality, because the assertion covers the whole row. A row
 * written long and left to the renderer loses its last fact with nothing to say
 * that it has — and the facts at the end are the way out of a modal and the way
 * back to the draft. Equality catches both the overflow and the silent cut.
 */
describe("REPL first use: UI10 narrow guidance", () => {
  it("UI10: at 72x20 the row says the state, what Enter does, and the way back, whole", function* () {
    const { page } = yield* mountJourney({ size: NARROW });

    // Focus starts in the draft. The state comes first, then what Enter there
    // does, then that typing goes to the draft, then movement.
    expect(guidanceRow(page.frame()).trim()).toBe(
      "Ready for Entry 1 · Enter submits · Type here · Tab/Shift+Tab move",
    );
    expect(guidanceRow(page.frame()).length).toBeLessThanOrEqual(NARROW.columns);

    // On a control, Enter activates the control rather than submitting, so the
    // row stops saying it submits and starts saying how to get back. `Sessions`
    // because it is a control with nothing particular to say about itself —
    // this is the generic spelling.
    yield* toTranscript(page);
    expect(guidanceRow(page.frame()).trim()).toBe(
      "Ready for Entry 1 · Enter activates · Tab/Shift+Tab move · Tab to draft",
    );
    expect(guidanceRow(page.frame()).length).toBeLessThanOrEqual(NARROW.columns);

    // And a control that does have something particular to say says it instead,
    // because a row naming an action the focused node does not perform is worse
    // than one naming none: the person presses the key it promised.
    yield* page.focus("footer:exit");
    expect(guidanceRow(page.frame()).trim()).toBe(
      "Ready for Entry 1 · Enter exits · Tab/Shift+Tab move · Tab to draft",
    );
    yield* page.focus("footer:history");
    expect(guidanceRow(page.frame()).trim()).toBe(
      "Ready for Entry 1 · Enter opens · Tab/Shift+Tab move · Tab to draft",
    );
    expect(guidanceRow(page.frame()).length).toBeLessThanOrEqual(NARROW.columns);

    yield* finish(page);
  });
});

/**
 * A drawer keeps the state and keeps the way out (#870 UI10/UI16).
 *
 * Inside a modal the order earns its keep: the drawer holds focus, so `Esc
 * closes` is the one key a person must be told about, and it is required ahead of
 * movement. The state stays because a question does not stop an entry from
 * running and a reader still needs to know that it is.
 */
describe("REPL first use: UI10 narrow drawer guidance", () => {
  it("UI10: at 72x20 a focused field and a focused drawer control each say state, action, Esc and movement", function* () {
    const { page } = yield* mountJourney({ size: NARROW });

    yield* submitted(page, SHORT_QUESTION);
    yield* page.until("the waiting question", asked);
    yield* page.focus("footer:asked");
    yield* page.key("Enter");
    yield* page.until(
      "the answer field holding focus",
      (frame) => frame.focused === "drawer:value:decision",
    );
    // The row follows the focus by a frame, and a row that says the same
    // thing twice draws no second one, so the window is real time.
    yield* lingering();

    // A field holds focus: Enter answers, and the entry is still named.
    const onField = guidanceRow(page.frame()).trim();
    expect(onField).toBe("Entry 1 question · Enter answers · Esc closes · Tab/Shift+Tab move");

    // The question's submit: the same promise, because activating it is how the
    // question gets answered.
    yield* page.focus("drawer:form:submit");
    yield* lingering();
    const onSubmit = guidanceRow(page.frame()).trim();
    expect(onSubmit).toBe("Entry 1 question · Enter answers · Esc closes · Tab/Shift+Tab move");

    // And a control in the same drawer that does something else entirely. It
    // moves the window over a message too long to draw at once, so the row says
    // that instead of promising an answer to somebody who is still reading.
    yield* page.focus("drawer:scroll:down");
    yield* lingering();
    const onScroll = guidanceRow(page.frame()).trim();
    expect(onScroll).toBe("Entry 1 question · Enter scrolls · Esc closes · Tab/Shift+Tab move");

    // Whichever node holds focus: the state, the action that node performs, the
    // way out, and movement — all four on one 72-column row, none of them cut.
    for (const row of [onField, onSubmit, onScroll]) {
      expect(row.startsWith("Entry 1 question · Enter ")).toBe(true);
      expect(row).toContain("Esc closes");
      expect(row).toContain("Tab/Shift+Tab move");
      expect(row.length).toBeLessThanOrEqual(NARROW.columns);
    }

    yield* finish(page);
  });
});

/**
 * The drawer is found by where it is placed, not by what it says (#870 UI15, adj 3).
 *
 * The state sentence is the word "History" at a frozen position, so a reading
 * that located the History drawer by that word read the sentence instead of the
 * list — from the wrong column, and answered with fragments of the transcript
 * behind it. This row stands in exactly that frame: the guidance says "History"
 * outside the drawer while the drawer lists positions inside it, and the
 * positions are the controls the layer placed.
 */
describe("REPL first use: UI15 drawer geometry", () => {
  it("UI15: guidance saying History does not move what reading the drawer answers", function* () {
    const { page } = yield* mountJourney({ size: WIDE });

    yield* submitted(page, "one");
    yield* page.until("the entry settling", (frame) => shows(frame, "Ready for Entry 2"));

    // Into a position, so the state sentence becomes the word the old helper
    // searched for.
    yield* page.focus("footer:history");
    yield* page.key("Enter");
    yield* page.until("the History drawer", historyOpen);
    const listed = positions(page.frame());
    expect(listed.length).toBeGreaterThan(0);
    yield* page.focus(listed[0].key);
    yield* page.key("Enter");
    yield* page.until("the frozen position", historical);

    // Reopened over a frozen position: now both are true at once.
    yield* page.key("Escape");
    yield* page.until(
      "the drawer closing",
      (frame) => frame.area("box:drawer:layer") === undefined,
    );
    yield* page.focus("footer:history");
    yield* page.key("Enter");
    yield* page.until("the History drawer again", historyOpen);
    const saying = page.frame().rows.findIndex((line) => line.includes("History ·"));
    expect(saying).toBeGreaterThanOrEqual(0);
    // Outside the drawer's own rows. It shares columns with the box at this
    // size, so the row is the distinction and the column is not — and this
    // screen keeps its History band *below* the body the drawer floats over,
    // so outside means either side of it rather than above it.
    const box = page.frame().area("box:drawer:layer")?.bounds;
    expect(box).toBeDefined();
    expect(saying < (box?.y ?? 0) || saying >= (box?.y ?? 0) + (box?.height ?? 0)).toBe(true);

    // And the drawer still answers with its own rows: every one of them is a
    // position this history holds, and none is a piece of the sentence or of
    // the transcript behind the box.
    //
    // Re-anchored for #881 PR 3, in two ways. A row used to be a bare label
    // and now carries its place in the recorded order, so "holds no `·`" —
    // which is how this told a row from the guidance sentence — would reject
    // every row; the shape `N · <category>` says the same thing and says
    // more. And the drawer at a frozen position now lists the *whole* order
    // rather than the prefix's share of it: the positions after the one being
    // read are where a reader can go next, which is the navigation exception
    // this slice exists for.
    const markers = positions(page.frame()).map((one) => one.text);
    expect(markers.length).toBeGreaterThan(0);
    expect(markers).toContain("1 · Entry 1 admitted");
    expect(markers.length).toBe(listed.length);
    for (const marker of markers) {
      expect([marker, /^\d+ · \S/.test(marker)]).toEqual([marker, true]);
      expect([marker, marker.startsWith("History")]).toEqual([marker, false]);
    }

    yield* finish(page);
  });
});

describe("REPL first use: UI12 refusal", () => {
  it("UI12: a lifecycle refusal keeps the draft and goes when the entry it named ends, untouched", function* () {
    const { page } = yield* mountJourney({ size: WIDE });

    // One entry that is still running, so there is something for the next
    // submission to be refused into.
    yield* submitted(page, SLOW_ENTRY);

    // A second document typed while the first is still going.
    const DRAFT_TEXT = "second entry, typed while the first is running";
    yield* paste(page, draft(page), DRAFT_TEXT);
    yield* page.key("Enter");
    yield* page.until("the refusal", (frame) => shows(frame, "has not finished"));

    // Refused, with its reason, and nothing taken from the person: the draft is
    // exactly what they typed, and the history is exactly one entry.
    expect(shows(page.frame(), DRAFT_TEXT)).toBe(true);
    expect(shows(page.frame(), "2. ")).toBe(false);

    // Nothing is pressed from here. The entry ends on its own.
    yield* page.until("the next entry being ready", (frame) => shows(frame, "Ready for Entry 2"));

    // The refusal is gone, because it stopped being true — and what replaced it
    // says the opposite of what it said.
    expect(shows(page.frame(), "has not finished")).toBe(false);
    // And the draft is still theirs.
    expect(shows(page.frame(), DRAFT_TEXT)).toBe(true);

    yield* finish(page);
  });
});

describe("REPL first use: UI1 narrow question", () => {
  it("UI1: the longest question still has a placed, targetable control at 72x20", function* () {
    const { page } = yield* mountJourney({ size: NARROW });

    // Asked with a message far wider than the terminal, and read from
    // Sessions, so this row also proves the crossing.
    //
    // Submitted where the draft is. This frame routes one outlet and the
    // Sessions one has no draft in it, so a person asks from the entries they
    // are reading and then goes to look at the Transcript — which is the
    // crossing this row is about: the announcement arrives while they are
    // somewhere else, and activating it takes them to the entry that asked.
    yield* submitted(page, LONG_QUESTION);
    yield* toTranscript(page);
    yield* page.until("the waiting question", asked);
    expect(surfaceRouted(page.frame(), "Sessions")).toBe(true);

    const answer = page.frame().control("footer:asked");
    if (answer === undefined) {
      throw new Error("the question announced itself");
    }
    const row = page.frame().rows[answer.bounds.y] ?? "";
    // Everything that belongs on the action row is on it, and the announcement
    // is placed rather than dropped: a control the row could not hold whole is
    // left out of the frame, and a waiting question left out is unreachable.
    expect(row).toContain("[history]");
    expect(row).toContain("[exit]");
    expect(row).toContain("[pause]");
    expect(row).toContain("[answer]");
    // Inside the terminal, so nothing of it is off the edge.
    expect(answer.bounds.x + answer.bounds.width).toBeLessThanOrEqual(NARROW.columns);

    // Activated by pointer: that is the target map answering for this column.
    yield* page.press("footer:asked");
    yield* page.until("the question's form", formShowing);

    // Dismissed, so the rows the location is drawn on are readable again — a
    // drawer covers what it is in front of, and the crossing it performed
    // survives it being closed.
    yield* page.key("Escape");
    yield* page.until("the drawer closing", (frame) => !formShowing(frame));
    expect(selectedEntry(page.frame())).toContain("Entry 1");
    expect(surfaceRouted(page.frame(), "Entries")).toBe(true);
    // Read in the catalog, which is where this screen keeps the rows.
    yield* openCatalog(page);
    const entry = page.frame().control("entry:entry-1")?.text;
    expect(entry).toContain("1. [unfinished] entry-1");
    expect(selectionMarked(entry)).toBe(true);
    yield* closeCatalog(page);

    // And reached again by Enter this time, because dismissing answered nothing.
    yield* page.focus("footer:asked");
    yield* page.key("Enter");
    yield* page.until("the question's form again", formShowing);

    yield* finish(page);
  });
});

describe("REPL first use: UI2 refusal", () => {
  it("UI2: a normal-sized refusal is left by its own visible control", function* () {
    const root = yield* useTemporary("xmd-repl-journey-");
    const { outcome, terminal } = yield* scoped(function* () {
      // One real execution to refuse a location against.
      yield* scoped(function* (): Operation<void> {
        const { page } = yield* mountJourney({ root });
        yield* finish(page);
      });

      const files = yield* histories(root);
      const path = yield* historyPath(root, files[0]);
      const before = yield* until(readFile(path, "utf8"));
      const execution = files[0].replace(/\.jsonl$/, "");

      // A location this history cannot answer: an entry it never admitted.
      const { page } = yield* mountJourney({
        root,
        location: `xmd://repl/${execution}/entries/entry-9`,
        reopening: true,
      });
      yield* page.until("the refusal", (frame) => shows(frame, "[exit]"));
      expect(shows(page.frame(), "admitted")).toBe(true);
      expect(shows(page.frame(), "[exit]")).toBe(true);
      // And nothing else: no draft, and no control this screen cannot honour.
      expect(page.frame().has("footer:history")).toBe(false);
      expect(page.frame().has("footer:input")).toBe(false);
      expect(shows(page.frame(), "[history]")).toBe(false);

      // Reached by pointer, which is the target map answering for that column.
      yield* page.press("footer:exit");
      const ended = yield* outcomeOf(page);
      expect(yield* until(readFile(path, "utf8"))).toBe(before);
      return { outcome: ended, terminal: page.repl.terminal };
    });

    // A refusal is still a refusal: the command reports it rather than reporting
    // success, and leaving it appended nothing.
    expect(outcome.ok).toBe(false);
    expect(terminal.resets).toBe(1);
  });

  it("UI2: Enter on the refusal's control leaves it too", function* () {
    const root = yield* useTemporary("xmd-repl-journey-");
    const { outcome, terminal } = yield* scoped(function* () {
      yield* scoped(function* (): Operation<void> {
        const { page } = yield* mountJourney({ root });
        yield* finish(page);
      });
      const execution = (yield* histories(root))[0].replace(/\.jsonl$/, "");

      const { page } = yield* mountJourney({
        root,
        location: `xmd://repl/${execution}/entries/entry-9`,
        reopening: true,
      });
      yield* page.until("the refusal", (frame) => shows(frame, "[exit]"));
      expect(shows(page.frame(), "admitted")).toBe(true);

      yield* page.focus("footer:exit");
      yield* page.key("Enter");
      return { outcome: yield* outcomeOf(page), terminal: page.repl.terminal };
    });

    expect(outcome.ok).toBe(false);
    expect(terminal.resets).toBe(1);
  });
});

describe("REPL first use: UI3", () => {
  it("UI3: a question that disappears takes its drawer, and answers nothing", function* () {
    const held = withResolvers<void>();
    yield* scoped(function* (): Operation<void> {
      const hosted = yield* useJourneyHost();
      // The sibling's hold, and the failure that releases it. A deadline rather
      // than a race: the drawer has to be *mounted* before the question goes, so
      // the sibling waits for this row to say so.
      yield* API.Fetch.around({
        *fetch(): Operation<never> {
          yield* held.operation;
          throw new Error("the sibling could not finish");
        },
      });
      const page = yield* startJourney(hosted);
      const files = yield* histories(hosted.root);

      yield* submitted(page, SIBLING_FAILS);

      // The question is asked and opened, the way a person opens it.
      yield* openQuestion(page);
      expect(shows(page.frame(), "[close]")).toBe(true);
      expect(shows(page.frame(), "decision: go")).toBe(true);

      // Now the sibling fails. The question goes with the expansion that was
      // asking it, while this process stays alive and keeps the screen.
      held.resolve();

      // The drawer and the form go together, and neither becomes an answer.
      yield* page.until("the drawer withdrawing", (frame) => !shows(frame, "decision: go"));
      expect(shows(page.frame(), "[close]")).toBe(false);
      // Focus is somewhere a person can use, not on a control that has gone: the
      // control the frame reports as focused is one it placed.
      const focused = page.frame().focused;
      expect(focused !== undefined && page.frame().has(focused)).toBe(true);

      // The entry keeps its own legitimate failure, and nothing recorded an
      // elicitation: a withdrawal is not a decision.
      yield* entrySettles(page, 1, "err");
      expect(
        (yield* records(hosted.root, files[0])).filter((line) => line.includes("elicit")),
      ).toEqual([]);

      // The draft still works, and the execution still takes another entry.
      yield* submitted(page, COLD_ONE);
      yield* entrySettles(page, 2, "ok");

      yield* finish(page);
    });
  });
});

describe("REPL first use: UI4", () => {
  it("UI4: a live question's drawer is refused wherever it cannot belong", function* () {
    const { page, root } = yield* mountJourney();

    yield* submitted(page, JOURNEY_ONE);
    yield* page.until("the waiting question", asked);
    const standing = page.frame().rows;
    const before = yield* records(root, (yield* histories(root))[0]);

    // A historical position cannot answer the question this process is asking,
    // and asking it to says so instead of freezing a live drawer into a prefix.
    yield* page.focus("footer:history");
    yield* page.key("Enter");
    yield* page.until("the History drawer", historyOpen);
    yield* page.press(markerKey(page, "Entry 1 admitted"));
    yield* page.until("a frozen position", historical);
    expect(historical(page.frame())).toBe(true);
    // The announcement is gone with the live state it belonged to: a frozen view
    // fills nothing from the head.
    yield* page.until("the announcement going", (frame) => !asked(frame));
    yield* page.press("drawer:close");
    yield* page.until(
      "the drawer closing",
      (frame) => frame.area("box:drawer:layer") === undefined,
    );
    yield* page.focus("footer:live");
    yield* page.key("Enter");
    yield* page.until("the waiting question again", asked);

    // Every refusal left the reading standing and the file alone. Focus is put
    // back where it was first, because closing a drawer leaves it wherever the
    // tree puts it when a branch unmounts — a fact about this tree rather than
    // about the refusals, and the two screens are only comparable from the same
    // place. The contextual row follows focus, so this is what makes the
    // comparison a claim about the reading.
    expect(historical(page.frame())).toBe(false);
    yield* page.focus("footer:input");
    expect(page.frame().rows).toEqual(standing);
    expect(yield* records(root, (yield* histories(root))[0])).toEqual(before);

    yield* finish(page);
  });
});

describe("REPL first use: UI6", () => {
  it("UI6: the draft stays visible and intact under a drawer, and is not editable through it", function* () {
    for (const size of [WIDE, NARROW]) {
      yield* scoped(function* (): Operation<void> {
        const { page } = yield* mountJourney({ size });

        yield* submitted(page, JOURNEY_ONE);

        // Typed before the drawer is up, because it is the *next* entry's text and
        // an admitted entry is immutable.
        yield* draft(page).type("next entry");
        const kept = draft(page).text();
        expect(kept).toBe("next entry");

        yield* openQuestion(page);

        // Still drawn, in the draft's own rows in the work it belongs to, which
        // the drawer sits above rather than across. The draft and the question
        // are both readable at once, which is exactly why the drawer stops
        // short of it. Read from the draft rather than from the frame's last
        // row — that row is the guidance, and the draft is in the body.
        const drawn = draft(page).text();
        expect(drawn).toContain("next entry");
        expect(shows(page.frame(), "decision: go")).toBe(true);

        // The modal owns the keystrokes: the draft is visible and not editable, so
        // text reaches the field the drawer focused and the draft keeps its bytes.
        yield* page.type("go");
        yield* page.until("the drawer's field taking the text", () =>
          form(page).value("decision").text().includes("go"),
        );
        expect(draft(page).text()).toEqual(drawn);

        // Dismissed, and the draft is reachable again with exactly what it had.
        yield* page.key("Escape");
        yield* page.until("the drawer closing", (frame) => !shows(frame, "decision: go"));
        yield* page.focus("footer:input");
        expect(draft(page).text()).toBe(kept);
        expect(draft(page).text()).toContain("next entry");

        yield* finish(page);
      });
    }
  });
});

describe("REPL first use: UI7", () => {
  it("UI7: leaving strips the drawers only this process could mount", function* () {
    const root = yield* useTemporary("xmd-repl-journey-");

    const { ended, waiting } = yield* scoped(function* () {
      const { page } = yield* mountJourney({ root });

      yield* submitted(page, JOURNEY_ONE);
      yield* openQuestion(page);

      // What the file holds while the question is still waiting, so that what
      // leaving appends is a comparison rather than an assumption.
      const files = yield* histories(root);
      const kept = yield* until(readFile(yield* historyPath(root, files[0]), "utf8"));

      // Left while the modal is up. The control is physically in the footer and
      // belongs to the modal's own subtree, so a pointer on it reaches it without
      // reaching past the trap.
      yield* page.press("footer:exit");
      return { ended: yield* returned(page), waiting: kept };
    });

    // The location it printed is one a second process can be handed: the drawer
    // that only this process could mount is not in it, and nothing was answered
    // to take it out.
    expect(ended.location).toBeDefined();
    expect(ended.location).not.toContain("+elicit");
    expect(ended.location).not.toContain("+permission");
    expect(ended.location).toContain("/entry-1");

    const path = yield* historyPath(root, (yield* histories(root))[0]);
    // Leaving appended nothing at all: no close, no cancellation, no audit.
    expect(yield* until(readFile(path, "utf8"))).toBe(waiting);
    // The entry was interrupted, so the file holds no close for it. An unfinished
    // entry is what it is; nothing fabricated a cancellation to tidy it up.
    const first = (yield* histories(root))[0];
    expect((yield* projectionOf(root, first)).entries[0]?.terminal).toBeUndefined();
    // And no answer was recorded for the question that was waiting.
    expect((yield* records(root, first)).filter((line) => line.includes("elicit"))).toEqual([]);

    // That location is one a second process accepts: it resolves, which is what
    // being reopenable means. An unfinished entry is handed back to the engine to
    // continue, so this reopen resumes rather than reconstructs — the provider it
    // reaches belongs to resumed execution, not to restoration.
    yield* scoped(function* (): Operation<void> {
      const { page } = yield* mountJourney({ root, location: ended.location, reopening: true });
      expect(selectedEntry(page.frame())).toContain("Entry 1");
      yield* finish(page);
    });

    // The settled half of the claim, on a history with nothing left to resume: the
    // same exit, and a cold reopen that reaches no provider and appends nothing.
    const settledRoot = yield* useTemporary("xmd-repl-journey-");
    const settledLocation = yield* scoped(function* (): Operation<string> {
      const { page } = yield* mountJourney({ root: settledRoot });
      yield* submitted(page, COLD_ONE);
      yield* entrySettles(page, 1, "ok");
      yield* page.press("footer:exit");
      return (yield* returned(page)).location;
    });

    expect(settledLocation).toBeDefined();
    const settledPath = yield* historyPath(settledRoot, (yield* histories(settledRoot))[0]);
    const settledBytes = yield* until(readFile(settledPath, "utf8"));

    const performed = yield* scoped(function* () {
      const hosted = yield* useJourneyHost({ root: settledRoot, reopening: true });
      const counted = yield* countPerformed();
      const page = yield* startJourney(hosted, { location: settledLocation });
      yield* finish(page);
      return counted;
    });

    expect(performed.asked).toBe(0);
    expect(performed.compiles).toBe(0);
    expect(yield* until(readFile(settledPath, "utf8"))).toBe(settledBytes);
    // The location the settled history ended at carries no live-only drawer either.
    expect(settledLocation).not.toContain("+elicit");
  });
});

describe("REPL first use: UI8", () => {
  it("UI8: the whole first-use path, using only what the screen says", function* () {
    // Wide, because step 4 reads what the answer made the document render and a
    // narrow frame mounts only its routed outlet — the transcript is not a region
    // it has. What a narrow frame does carry is proved by the rows above.
    const { terminal, outcome } = yield* scoped(function* () {
      const { page, root } = yield* mountJourney({ size: WIDE });

      // 1. The screen says where typing goes and what Enter there does.
      expect(shows(page.frame(), "Type here")).toBe(true);
      expect(shows(page.frame(), "Enter submits")).toBe(true);
      yield* submitted(page, JOURNEY_ONE);

      // 2. Running, and then waiting — said on the entry's own row and in the
      // footer, without anything opening itself.
      yield* entrySettles(page, 1, "unfinished");
      yield* page.until("the waiting question", asked);

      // 3. Between the surfaces and back, with the selected entry preserved.
      yield* toTranscript(page);
      expect(surfaceRouted(page.frame(), "Sessions")).toBe(true);
      yield* toEntries(page);
      expect(surfaceRouted(page.frame(), "Entries")).toBe(true);

      // 4. The question, answered in the drawer it opens.
      yield* openQuestion(page);
      yield* page.press("drawer:field:decision");
      yield* page.type("go");
      yield* page.until("the field holding the answer", () =>
        form(page).value("decision").text().includes("go"),
      );
      yield* form(page).submit();
      yield* page.until("the answer's output", (frame) => shows(frame, "One: alpha/go"));
      yield* entrySettles(page, 1, "ok");

      // 5. A history position, and back to the head.
      yield* page.focus("footer:history");
      yield* page.key("Enter");
      yield* page.until("the History drawer", historyOpen);
      yield* page.press(markerKey(page, "Entry 1 admitted"));
      yield* page.until("a frozen position", historical);
      expect(historical(page.frame())).toBe(true);
      yield* page.press("drawer:close");
      yield* page.until(
        "the drawer closing",
        (frame) => frame.area("box:drawer:layer") === undefined,
      );
      // Frozen: what the draft's guidance says changes, because what Enter there
      // does changed — there is no head to submit into from here.
      yield* page.focus("footer:input");
      yield* page.until("the guidance for a frozen draft", (frame) =>
        says(frame, "box:guidance", "activate live to return to the head"),
      );
      expect(shows(page.frame(), "Enter submits")).toBe(false);
      yield* page.focus("footer:live");
      yield* page.key("Enter");
      yield* page.until("the head", (frame) => !historical(frame));

      // 6. The next entry, after the first has completely settled.
      yield* submitted(page, COLD_TWO);
      yield* entrySettles(page, 2, "ok");
      // Read in the catalog, which is where this screen keeps the rows.
      yield* openCatalog(page);
      expect(page.frame().control("entry:entry-2")?.text).toContain("2. [ok] entry-2");
      yield* closeCatalog(page);

      // 7. Out, from the control that said so all along.
      expect(yield* histories(root)).toHaveLength(1);
      yield* page.focus("footer:exit");
      yield* page.key("Enter");
      return { terminal: page.repl.terminal, outcome: yield* returned(page) };
    });

    expect(outcome.refusal).toBeUndefined();
    expect(outcome.location).toContain("xmd://repl/");
    expect(terminal.resets).toBe(1);
  });
});

/**
 * The whole first-use path at the narrowest supported frame (#870 C1).
 *
 * `UI8` walks this path at `160x36`, where there is a transcript column to read
 * the answer's output in. A narrow frame has no transcript region at all — it
 * mounts one routed outlet — so this row proves the other half of the behavior: that
 * everything a person has to *do* is reachable at `72x20`, found from the labels
 * and the one guidance row, with no hidden key and no semantic lookup.
 *
 * Every control here is reached the way a person reaches it: Tab to it and press
 * Enter, or click the control the frame placed.
 */
describe("REPL first use: C1 narrow", () => {
  it("C1: submit, answer, dismiss, reopen, settle, Sessions, History, live and exit at 72x20", function* () {
    const outcome = yield* scoped(function* (): Operation<ReplOutcome> {
      const { page } = yield* mountJourney({ size: NARROW });

      // 1. What the screen says it is for, before anything has been typed.
      expect(guidanceRow(page.frame()).trim()).toBe(
        "Ready for Entry 1 · Enter submits · Type here · Tab/Shift+Tab move",
      );

      // 2. One entry, submitted the way the row said to submit it.
      yield* submitted(page, SHORT_QUESTION);
      yield* page.until("the waiting question", asked);

      // 3. The screen now says what the execution is doing, and what to activate.
      expect(guidanceRow(page.frame()).trim()).toBe(
        "Entry 1 question · activate answer · Type here · Tab/Shift+Tab move",
      );

      // 4. Reached by pointer, against the control the frame placed for it.
      yield* page.press("footer:asked");
      yield* page.until("the question's form", formShowing);

      // 5. Escape dismisses without answering, and leaves focus somewhere real.
      yield* page.key("Escape");
      yield* page.until("the drawer closing", (frame) => !formShowing(frame));
      expect(asked(page.frame())).toBe(true);
      // Focus is derived from the tree, so it lands on the next frame rather than
      // in the same one the drawer left. Waited for, because the claim is that it
      // arrives somewhere real — on the control still asking.
      yield* page.until(
        "focus returning to the waiting question",
        (frame) => frame.focused === "footer:asked",
      );

      // 6. Reopened with Enter this time, because dismissing answered nothing.
      yield* page.key("Enter");
      yield* page.until("the question's form again", formShowing);

      // 7. Answered by typing into the field that holds focus, then submitting.
      yield* form(page).value("decision").type("go");
      yield* page.focus("drawer:form:submit");
      yield* page.key("Enter");
      yield* page.until("the entry settling", (frame) => shows(frame, "Ready for Entry 2"));
      // Read in the catalog, which is where this screen keeps the rows.
      yield* openCatalog(page);
      expect(page.frame().control("entry:entry-1")?.text).toContain("1. [ok] entry-1");
      yield* closeCatalog(page);

      // 8. Sessions and back, with the entry still the one being read.
      yield* toTranscript(page);
      yield* page.until("the Sessions surface", (frame) => routedSurface(frame) === "Sessions");
      yield* toEntries(page);
      yield* page.until("the Entries surface", (frame) => routedSurface(frame) === "Entries");

      // 9. A draft that has to survive a position, and a position to survive.
      yield* draft(page).type("entry two");
      yield* page.focus("footer:history");
      yield* page.key("Enter");
      yield* page.until("the History drawer", historyOpen);
      const listed = positions(page.frame());
      expect(listed.length).toBeGreaterThan(0);
      yield* page.focus(listed[0].key);
      yield* page.key("Enter");

      // 10. Frozen: it says so, says Enter is not a submission, and offers back.
      // Read from the guidance row rather than the location, because at 72
      // columns the location is drawn over several rows and says how much of
      // itself it is not showing — the sentence is what a person reads here.
      // The position is taken while the drawer is still up, and the row already
      // names the state it put the screen in rather than waiting to be dismissed.
      yield* page.until("the frozen state inside the drawer", (frame) =>
        guidanceRow(frame).trim().startsWith("History · "),
      );
      expect(guidanceRow(page.frame())).toContain("Esc closes");

      // 10. Dismissed, and back in the draft — which a frozen position leaves
      // editable — the row says what this position cannot do and how to leave it.
      yield* page.key("Escape");
      yield* page.until("the drawer closing", (frame) => !shows(frame, "[close]"));
      yield* page.focus("footer:input");
      yield* page.until("the frozen guidance", (frame) =>
        guidanceRow(frame).trim().startsWith("History · Enter unavailable"),
      );
      expect(guidanceRow(page.frame())).toContain("activate live");
      expect(shows(page.frame(), "entry two")).toBe(true);

      // 11. Back to the head, and the draft submits from there.
      yield* page.focus("footer:live");
      yield* page.key("Enter");
      yield* page.until("the head being ready again", (frame) =>
        guidanceRow(frame).trim().startsWith("Ready for Entry 2"),
      );
      yield* page.focus("footer:input");
      yield* page.key("Enter");
      // In the rail, which is where the head's own record of it is. `2. ` is a
      // catalog row, and the catalog is a drawer nobody opened here.
      yield* entrySettles(page, 2, "ok");

      // 12. And out, from a control on the screen.
      yield* page.focus("footer:exit");
      yield* page.key("Enter");
      return yield* returned(page);
    });
    expect(outcome.location).toContain("xmd://repl/");
  });
});
