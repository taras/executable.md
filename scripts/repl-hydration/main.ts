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
  EXECUTION,
  JOURNAL,
  journalChanging,
  journalDropping,
  journalWithout,
  LIVE_HEAD,
  PAUSE_MARKER,
  positionOf,
} from "./fixture.ts";
import { parseJournal } from "./journal.ts";
import type { SemanticEvent } from "./journal.ts";
import { decodeRoute, encodeRoute, resolveLocation } from "./location.ts";
import type { SemanticModel } from "./model.ts";
import * as overlay from "./overlay.ts";
import { markersOf, projectPrefix } from "./project.ts";
import { foreignValues } from "./purity.ts";

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

function* run(): Operation<void> {
  const parsed = events(JOURNAL);

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
}

if (import.meta.main) {
  await main(run);
}
