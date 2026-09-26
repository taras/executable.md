/**
 * The documented command.
 *
 *   deno task repl:hydration
 *
 * It reads the fixture journal once and prints what Slice 1 claims: the
 * Execution History the records mint, the three prefixes #842 navigates
 * between, what each one can and cannot see, the purity walk over a projected
 * model, and one refusal of each kind.
 *
 * It renders nothing and mounts nothing. There is no store here yet and no
 * process holding expansion — the overlay is printed beside the projection
 * precisely to show that the projection does not consult it.
 */

import { main } from "effection";
import type { Operation } from "effection";

import {
  BEFORE_FAILURE,
  EXECUTION,
  JOURNAL,
  journalChanging,
  journalDropping,
  journalWithout,
  LIVE_HEAD,
  PAUSE_MARKER,
  positionOf,
  TERMINAL_JOURNAL,
  TERMINAL_MARKERS,
} from "./fixture.ts";
import { MARKER_POLICY, parseJournal, SEMANTIC_KINDS } from "./journal.ts";
import type { SemanticEvent } from "./journal.ts";
import { decodeRoute, encodeRoute, resolveLocation } from "./location.ts";
import type { Outcome, Scope, SemanticModel } from "./model.ts";
import * as overlay from "./overlay.ts";
import { markersOf, projectPrefix } from "./project.ts";
import { foreignValues } from "./purity.ts";
import { layout, topology } from "./layout.ts";
import type { Viewport } from "./layout.ts";
import { createStreaming, noSecrets, scriptedSecrets } from "./ephemeral.ts";
import { answered, elicitation, resume, SCRIPT } from "./replay.ts";
import { hydrate } from "./store.ts";
import type { ReplSession, SemanticState } from "./store.ts";

const AT_PAUSE = `xmd://repl/e1/transcript/entry-3/document/publish/+source/+confirm?at=${PAUSE_MARKER}&inspect`;
const AT_HEAD = "xmd://repl/e1/transcript/entry-3/document/write";
const HISTORICAL = "xmd://repl/e1/bindings?at=r-16";

function events(records: readonly unknown[]): readonly SemanticEvent[] {
  const parsed = parseJournal(records);
  if (!parsed.ok) {
    throw parsed.error;
  }
  return parsed.value;
}

function model(parsed: readonly SemanticEvent[], through?: string): SemanticModel {
  const projected = projectPrefix(EXECUTION, parsed, through);
  if (!projected.ok) {
    throw projected.error;
  }
  return projected.value;
}

function describe(one: SemanticModel): string {
  const bindings = one.bindings.map((binding) => `${binding.name}=${binding.value}`).join(" ");
  const waits = one.suspensions.map((suspension) => suspension.wait).join(" ");
  const outcomes = one.outcomes.map((outcome) => outcome.label).join(" ");
  return [
    `  records   : ${one.records}`,
    `  marker    : ${one.marker} @${one.at}`,
    `  entries   : ${one.entries.map((entry) => `${entry.id}:${entry.outcome.status}`).join(" ")}`,
    `  bindings  : ${bindings === "" ? "none" : bindings}`,
    `  drawers   : ${waits === "" ? "none" : waits}`,
    `  outcomes  : ${outcomes === "" ? "none" : outcomes}`,
  ].join("\n");
}

function say(outcome: Outcome): string {
  return outcome.status === "failed" || outcome.status === "interrupted"
    ? `${outcome.status} (${outcome.reason})`
    : outcome.status;
}

function lines(scopes: readonly Scope[], indent: string): readonly string[] {
  return scopes.flatMap((scope) => [
    `${indent}${scope.name}: ${say(scope.outcome)}`,
    ...lines(scope.children, `${indent}  `),
  ]);
}

function refusal(what: string, thrown: unknown): string {
  return thrown instanceof Error ? `  ${what}: ${thrown.name} — ${thrown.message}` : `  ${what}: ?`;
}

function refused(what: string, records: readonly unknown[]): string {
  const parsed = parseJournal(records);
  if (parsed.ok) {
    return `  ${what}: ACCEPTED, which is a defect`;
  }
  return refusal(what, parsed.error);
}

/** The journey #842 names, as the locations it visits and what has arrived. */
const JOURNEY: readonly {
  readonly name: string;
  readonly url: string;
  readonly records: number;
}[] = [
  { name: "empty", url: "xmd://repl/e1/transcript", records: 0 },
  { name: "the first entry", url: "xmd://repl/e1/transcript/entry-1", records: 1 },
  { name: "nested scopes", url: "xmd://repl/e1/transcript/entry-1/document/plan", records: 3 },
  { name: "a published binding", url: "xmd://repl/e1/bindings", records: 7 },
  { name: "the expansion pause marker", url: AT_PAUSE, records: 22 },
  { name: "a background append, expansion held", url: AT_PAUSE, records: 23 },
  {
    name: "historical inspection",
    url: "xmd://repl/e1/transcript/entry-1/document?at=r-03",
    records: 23,
  },
  { name: "the live head", url: AT_HEAD, records: 23 },
  { name: "back to the pause marker", url: AT_PAUSE, records: 23 },
];

const WIDE: Viewport = { columns: 120, rows: 40 };
const NARROW: Viewport = { columns: 28, rows: 40 };

function* session(url: string, records: readonly unknown[]): Operation<ReplSession> {
  const opened = yield* hydrate(EXECUTION, url, records);
  if (!opened.ok) {
    throw opened.error;
  }
  return opened.value;
}

function same(one: SemanticState, other: SemanticState): boolean {
  return JSON.stringify(one) === JSON.stringify(other);
}

function* walkJourney(): Operation<void> {
  const live = yield* session("xmd://repl/e1/transcript", []);
  console.log("— the journey, accumulated live against a cold rebuild —");
  for (const step of JOURNEY) {
    for (const record of JOURNAL.slice(live.state().records.length, step.records)) {
      const applied = yield* live.append(record);
      if (!applied.ok) {
        throw applied.error;
      }
    }
    const moved = yield* live.navigate(step.url);
    if (!moved.ok) {
      throw moved.error;
    }
    const cold = yield* session(step.url, JOURNAL.slice(0, step.records));
    const state = live.semantic();
    const future = state.history.filter((one) => one.position === "future").length;
    console.log(
      `  ${step.name.padEnd(38)} prefix ${(state.model.marker || "none").padEnd(5)} records ${String(
        state.model.records,
      ).padStart(2)}  future markers ${future}  rebuild identical ${same(state, cold.semantic())}`,
    );
  }
  console.log("");

  const held = overlay.live(PAUSE_MARKER);
  const paused = live.semantic();
  console.log("— Continue is the live process's to offer —");
  console.log(
    `  at ${paused.model.marker}, holding      : ${overlay.canContinueAt(held, paused.model.marker)}`,
  );
  console.log(
    `  at ${paused.model.marker}, released     : ${overlay.canContinueAt(overlay.released(held), paused.model.marker)}`,
  );
  console.log(
    `  at ${paused.model.marker}, after restart: ${overlay.canContinueAt(overlay.cold(), paused.model.marker)}`,
  );
  console.log(`  the reconstruction is unchanged  : ${same(live.semantic(), paused)}`);
  console.log("");

  console.log("— the cache accelerates and decides nothing —");
  console.log(`  memoized markers      : ${live.cached().join(" ")}`);
  const warm = live.semantic();
  yield* live.discardSnapshots();
  const again = yield* live.navigate(AT_PAUSE);
  if (!again.ok) {
    throw again.error;
  }
  console.log(`  after discarding them : ${same(live.semantic(), warm)}`);
  console.log("");

  console.log("— one state, two terminals —");
  const wide = layout(warm, WIDE);
  const narrow = layout(warm, NARROW);
  console.log(`  lines at ${WIDE.columns} columns : ${wide.length}`);
  console.log(`  lines at ${NARROW.columns} columns  : ${narrow.length}`);
  console.log(
    `  topology identical    : ${
      JSON.stringify(topology(warm.model)) === JSON.stringify(topology(live.semantic().model))
    }`,
  );
  console.log(
    `  nothing foreign in the store: ${
      foreignValues(live.state(), "state").length === 0 ? "clean" : "FOUND"
    }`,
  );
}

/** The secret this trace uses, so the sweep below has something to look for. */
const TOKEN = "npm_Ie4Xz9QqSECRETvalue";

function* walkRestart(): Operation<void> {
  const channel = elicitation("channel");
  const token = elicitation("token");

  const first = resume({
    script: SCRIPT,
    prior: [],
    streaming: createStreaming(),
    secrets: noSecrets(),
  });
  if (!first.ok) {
    throw first.error;
  }
  console.log("— a first run, live —");
  console.log(`  performed : ${first.value.performed.join(", ")}`);
  console.log(
    `  frontier  : ${first.value.frontier.kind} ${
      first.value.frontier.kind === "complete" ? "" : first.value.frontier.wait
    }`,
  );
  console.log("");

  const withChannel = answered(first.value.records, channel, "#releases");
  if (!withChannel.ok) {
    throw withChannel.error;
  }
  const second = resume({
    script: SCRIPT,
    prior: withChannel.value,
    streaming: createStreaming(),
    secrets: noSecrets(),
  });
  if (!second.ok) {
    throw second.error;
  }
  const withToken = answered(second.value.records, token, "");
  if (!withToken.ok) {
    throw withToken.error;
  }
  const records = withToken.value;

  const secrets = scriptedSecrets({ token: TOKEN });
  const streaming = createStreaming();
  const replayed = resume({ script: SCRIPT, prior: records, secrets, streaming });
  if (!replayed.ok) {
    throw replayed.error;
  }
  console.log("— the same document after process loss —");
  console.log(
    `  performed again : ${replayed.value.performed.length === 0 ? "nothing" : replayed.value.performed.join(", ")}`,
  );
  console.log(`  consumed        : ${replayed.value.consumed.join(", ")}`);
  console.log(`  recovered       : ${replayed.value.recovered.join(", ")}`);
  console.log(`  re-prompted for : ${replayed.value.asked.join(", ")}`);
  console.log(
    `  partial output  : ${replayed.value.streaming.length === 0 ? "none" : replayed.value.streaming.join(", ")}`,
  );
  console.log(`  frontier        : ${replayed.value.frontier.kind}`);

  const headless = resume({
    script: SCRIPT,
    prior: records,
    secrets: noSecrets(),
    streaming: createStreaming(),
  });
  if (!headless.ok) {
    throw headless.error;
  }
  console.log(
    `  with nobody to ask: ${headless.value.frontier.kind} ${
      headless.value.frontier.kind === "complete" ? "" : headless.value.frontier.wait
    }`,
  );
  console.log("");

  const restarted = yield* session("xmd://repl/e3/transcript/entry-1/document/draft", records);
  const typed = yield* restarted.type(TOKEN.slice(0, 4));
  if (!typed.ok) {
    throw typed.error;
  }
  const draft = restarted.semantic().model.entries[0].scopes[0].children[0];
  console.log("— what the restart shows —");
  console.log(
    `  admitted result : ${restarted
      .semantic()
      .model.outcomes.map((one) => one.label)
      .join(", ")}`,
  );
  console.log(
    `  its scopes      : ${draft.name} > ${draft.children.map((one) => one.name).join(" ")}`,
  );
  console.log(`  journal records : ${restarted.state().records.length} (typing appended none)`);
  console.log(`  navigation stack: ${restarted.visits().length}`);
  console.log(
    `  Continue offered: ${overlay.canContinueAt(overlay.cold(), restarted.semantic().model.marker)}`,
  );
  console.log("");

  const swept = [
    JSON.stringify(records),
    JSON.stringify(restarted.state()),
    JSON.stringify(restarted.visits()),
    JSON.stringify(secrets.asked),
    JSON.stringify(replayed.value),
  ];
  const foreign = records.map((record) => ({ ...Object(record), entry: "other-entry" }));
  const diverged = resume({
    script: SCRIPT,
    prior: foreign,
    secrets: noSecrets(),
    streaming: createStreaming(),
  });
  const swapped = records.map((record) => {
    const one = Object(record);
    return one.kind === "binding.published" ? { ...one, name: "other", value: "wrong" } : one;
  });
  const wrongBinding = resume({
    script: SCRIPT,
    prior: swapped,
    secrets: noSecrets(),
    streaming: createStreaming(),
  });
  console.log("— a record is consumed only when it is this step's own —");
  console.log(
    `  another document's journal: ${diverged.ok ? "ACCEPTED, which is a defect" : diverged.error.message}`,
  );
  console.log(
    `  another binding, right kind: ${wrongBinding.ok ? "ACCEPTED, which is a defect" : wrongBinding.error.message}`,
  );
  console.log(`  the supplied journal is unchanged: ${foreign.length === records.length}`);
  console.log("");

  console.log("— the secret —");
  console.log(`  asked for again in : ${secrets.asked.join(", ")}`);
  console.log(
    `  present in journal, store, navigation, audit or run: ${
      swept.some((surface) => surface.includes(TOKEN)) ? "FOUND, which is a defect" : "nowhere"
    }`,
  );
}

function* run(): Operation<void> {
  const parsed = events(JOURNAL);

  console.log("— the marker policy —");
  for (const kind of SEMANTIC_KINDS) {
    console.log(`  ${kind.padEnd(20)} ${MARKER_POLICY[kind]}`);
  }
  console.log("");

  console.log("— the Journal, and the Execution History it mints —");
  console.log(`  durable records : ${parsed.length}`);
  console.log(`  semantic markers: ${markersOf(parsed).length}`);
  console.log(`  ${markersOf(parsed).join(" ")}`);
  console.log("");

  const held = overlay.live(PAUSE_MARKER);
  console.log("— two independent positions —");
  console.log(`  expansion pause point (live overlay): ${held.pauseMarker}`);
  console.log(`  live History head (durable)         : ${model(parsed).marker}`);
  console.log("");

  console.log(`— the prefix at the expansion pause point, ${PAUSE_MARKER} —`);
  console.log(describe(model(parsed, PAUSE_MARKER)));
  console.log("");

  console.log(`— the prefix at the live head, ${LIVE_HEAD} —`);
  console.log(describe(model(parsed, LIVE_HEAD)));
  console.log("");

  console.log("— an earlier historical marker, r-16 —");
  console.log(describe(model(parsed, "r-16")));
  console.log("");

  console.log("— source order, not dispatch order —");
  const document = model(parsed).entries[2].scopes[0];
  console.log(`  opened  : publish (r-17) then write (r-18)`);
  console.log(`  projects: ${document.children.map((scope) => scope.name).join(" then ")}`);
  console.log("");

  console.log("— what each entry inherited —");
  for (const entry of model(parsed).entries) {
    const inherited = entry.inherited.map((binding) => `${binding.name}=${binding.value}`);
    console.log(`  ${entry.id}: ${inherited.length === 0 ? "nothing" : inherited.join(" ")}`);
  }
  console.log("");

  console.log("— how an entry ends —");
  const terminal = events(TERMINAL_JOURNAL);
  console.log(`  durable records : ${terminal.length}`);
  console.log(`  semantic markers: ${markersOf(terminal).length}`);
  for (const [name, marker] of Object.entries(TERMINAL_MARKERS)) {
    const ended = model(terminal, marker);
    const last = ended.markers[ended.markers.length - 1];
    console.log(`  ${marker} ${name.padEnd(12)} weight=${last.weight}`);
    for (const entry of ended.entries) {
      console.log(`    ${entry.id} ${say(entry.outcome)}`);
      for (const line of lines(entry.scopes, "      ")) {
        console.log(line);
      }
    }
  }
  const before = model(terminal, BEFORE_FAILURE);
  const endings = before.entries.filter(
    (entry) => entry.outcome.status === "failed" || entry.outcome.status === "interrupted",
  );
  console.log(`  before the failure (${BEFORE_FAILURE}): ${endings.length} ended entries`);
  console.log(
    `  release survives the failure: ${model(terminal)
      .bindings.map((binding) => `${binding.name}=${binding.value}`)
      .join(" ")}`,
  );
  console.log("");

  console.log("— three locations —");
  for (const url of [AT_PAUSE, AT_HEAD, HISTORICAL]) {
    const route = decodeRoute(url);
    if (!route.ok) {
      console.log(refusal(url, route.error));
      continue;
    }
    const located = resolveLocation(route.value, EXECUTION, parsed);
    if (!located.ok) {
      console.log(refusal(url, located.error));
      continue;
    }
    const where = located.value;
    const inside =
      where.kind === "entry"
        ? `${where.entry.id} ${where.scopes.map((scope) => scope.name).join("/")} drawers=${where.drawers.length}`
        : "—";
    console.log(`  ${encodeRoute(where.route)}`);
    console.log(`    surface ${where.surface}, prefix ${where.model.marker}, ${inside}`);
  }
  console.log("");

  console.log("— nothing foreign reached the model —");
  const foreign = foreignValues(model(parsed));
  console.log(`  ${foreign.length === 0 ? "clean" : foreign.join("\n  ")}`);
  console.log(`  overlay is a separate value: ${JSON.stringify(overlay.cold())}`);
  console.log("");

  console.log("— refusals —");
  console.log(
    refused(
      "a record naming the pause controller",
      journalChanging(positionOf("r-22"), { kind: "pause.held" }),
    ),
  );
  console.log(
    refused(
      "a record carrying a continuation    ",
      journalChanging(positionOf("r-22"), { continuation: "held" }),
    ),
  );
  console.log(
    refused("a truncated record                  ", journalDropping(positionOf("r-07"), "value")),
  );
  console.log(
    refused(
      "a reordered journal                 ",
      journalChanging(positionOf("r-07"), { seq: 99 }),
    ),
  );

  const overlapping = parseJournal(journalWithout(positionOf("r-09")));
  if (overlapping.ok) {
    const projected = projectPrefix(EXECUTION, overlapping.value);
    console.log(
      `  overlapping entries                 : ${projected.ok ? "ACCEPTED, which is a defect" : projected.error.message}`,
    );
  }

  const impossible = parseJournal(journalWithout(positionOf("r-08")));
  if (impossible.ok) {
    const projected = projectPrefix(EXECUTION, impossible.value);
    console.log(
      `  impossible scope closure            : ${projected.ok ? "ACCEPTED, which is a defect" : projected.error.message}`,
    );
  }

  const unresolved = decodeRoute("xmd://repl/e1/transcript/entry-3/document/plan");
  if (unresolved.ok) {
    const answer = resolveLocation(unresolved.value, EXECUTION, parsed);
    console.log(
      `  a URL the execution never went to   : ${answer.ok ? "ACCEPTED, which is a defect" : answer.error.message}`,
    );
  }
  console.log("");

  yield* walkJourney();
  console.log("");

  yield* walkRestart();
}

if (import.meta.main) {
  await main(run);
}
