/**
 * One location, followed all the way down.
 *
 * #840 asks for a trace that shows the same thing at every layer rather than
 * seven reports that happen to agree, so every line below is read from the one
 * place that answers it: the route from the URL, the identities from the model,
 * the topology and the focus chain from the mounted tree, the delivery from a
 * real dispatch through that tree, and the output from a render walk of it.
 *
 * Nothing here is a second representation. If a line of this trace is wrong,
 * what it describes is wrong.
 */

import type { Operation } from "effection";
import { current } from "../repl-study/vendor/freedom/upstream/index.ts";
import type { Node, Root } from "../repl-study/vendor/freedom/upstream/index.ts";

import type { Description } from "./component.ts";
import type { FrameClock } from "./frames.ts";
import type { Host } from "./host.ts";
import type { ReplModel } from "./model.ts";
import { focusTargets, keyOf, topology } from "./reconcile.ts";
import { decodeRoute, encodeRoute, resolveRoute } from "./router.ts";
import { describeScreen } from "./screen.ts";
import type { SessionSnapshot, Viewport } from "./screen.ts";

export interface Trace {
  /** 1. what the URL decoded to, written back canonically. */
  readonly decoded: string;
  /** 2. the exact model values it resolved to, or the refusal. */
  readonly resolved: readonly string[];
  /** 3. the keyed component description, as the tree it asks for. */
  readonly described: readonly string[];
  /** 4. the mounted Freedom ancestry, and what can take focus in it. */
  readonly mounted: readonly string[];
  readonly focus: readonly string[];
  /** 5. where an activation went, and what it meant. */
  readonly delivery: readonly string[];
  /** 6. what a closing branch took with it, and what still wants frames. */
  readonly teardown: readonly string[];
  /** 7. the terminal output, drawn from that same mounted tree. */
  readonly output: readonly string[];
}

/** The ancestry of one node, outermost first, by the keys it was described by. */
function ancestry(node: Node): string[] {
  const path: string[] = [];
  for (let at: Node | undefined = node; at; at = at.parent) {
    const key = keyOf(at);
    if (key !== undefined) {
      path.unshift(key);
    }
  }
  return path;
}

/**
 * Follow one URL through every layer, and report what each one said.
 *
 * `closing` is the URL the same run moves to afterwards, so the teardown line
 * is a real branch removal rather than a description of one.
 */
export function* traceLocation(
  url: string,
  closing: string,
  model: ReplModel,
  host: Host,
  root: Root,
  clock: FrameClock,
  session: SessionSnapshot,
  viewport: Viewport,
): Operation<Trace> {
  const decoded = decodeRoute(url);
  if (!decoded.ok) {
    return {
      decoded: `refused: ${decoded.error.message}`,
      resolved: [],
      described: [],
      mounted: [],
      focus: [],
      delivery: [],
      teardown: [],
      output: [],
    };
  }

  const outcome = resolveRoute(decoded.value, model);
  const resolved = outcome.ok
    ? [
        `checkpoint ${outcome.value.checkpoint.marker} @ ${outcome.value.checkpoint.at}s`,
        `entry ${outcome.value.entry?.id ?? "none"}`,
        `scopes ${outcome.value.scopes.map((scope) => scope.name).join("/") || "none"}`,
        `drawers ${outcome.value.drawers.map((one) => `${one.entry}:${one.kind}`).join(" → ") || "none"}`,
        `identities ${outcome.value.checkpoint === modelCheckpoint(model, outcome.value.checkpoint.marker) ? "are the model's own values" : "were copied"}`,
      ]
    : [`refused at ${refusalPosition(outcome.error)}: ${outcome.error.message}`];

  const descriptions = describeScreen(outcome, session, viewport);
  const described = descriptionTree(descriptions, 0);

  const shown = yield* host.show(descriptions);
  if (!shown.ok) {
    return {
      decoded: encodeRoute(decoded.value),
      resolved,
      described,
      mounted: [`refused: ${shown.error.message}`],
      focus: [],
      delivery: [],
      teardown: [],
      output: [],
    };
  }

  yield* host.advance(16);

  // Where the URL put focus, before anything is interacted with.
  const reconstructed = ancestry(current(root.node));

  // Then one explicit, generic interaction to reach a control: a pointer on it.
  // The host resolves that target against the live tree and moves focus there,
  // which is the same path a real click takes — nothing here calls `focus()`.
  const targets = focusTargets(root.node);
  const innermost = targets[targets.length - 1];
  const pointed =
    innermost === undefined
      ? { target: "", path: [], action: undefined }
      : host.deliver({ kind: "pointer", button: "primary", on: innermost.id });

  // And the same activation by keyboard, now that focus is there.
  const typed = host.deliver({ kind: "bytes", bytes: Uint8Array.from([13]) });

  const delivery = [
    `focus reconstructed from the URL at ${reconstructed.join(" › ")}`,
    `pointer target ${innermost === undefined ? "none" : ancestry(innermost).join(" › ")}`,
    `pointer path ${pointed.path.join(" › ")}`,
    `pointer action ${pointed.action?.kind ?? "none"}`,
    `focus now at ${ancestry(current(root.node)).join(" › ")}`,
    `keyboard path ${typed.path.join(" › ")}`,
    `keyboard action ${typed.action?.kind ?? "none"}`,
    `equivalent ${
      typed.action?.kind === pointed.action?.kind && typed.path.join() === pointed.path.join()
        ? "yes"
        : "no"
    }`,
  ];

  const before = topology(root.node);
  const demandBefore = clock.demand;

  const closed = decodeRoute(closing);
  const nextOutcome = closed.ok ? resolveRoute(closed.value, model) : closed;
  yield* host.show(describeScreen(nextOutcome, session, viewport));

  const after = topology(root.node);
  const teardown = [
    `closing to ${closing}`,
    `removed ${before.filter((key) => !after.includes(key)).join(", ") || "nothing"}`,
    `remaining ${after.join(", ")}`,
    `frame demand ${demandBefore} → ${clock.demand}`,
  ];

  // Put the traced location back so the output line describes the location the
  // trace is about.
  yield* host.show(descriptions);
  yield* host.advance(32);

  return {
    decoded: encodeRoute(decoded.value),
    resolved,
    described,
    mounted: topology(root.node),
    focus: focusTargets(root.node).map((node) => keyOf(node) ?? node.name),
    delivery,
    teardown,
    output: host.draw().split("\n"),
  };
}

function modelCheckpoint(model: ReplModel, marker: string): unknown {
  return model.checkpoints.find((checkpoint) => checkpoint.marker === marker);
}

function refusalPosition(error: Error): string {
  return "position" in error && typeof error.position === "string" ? error.position : "the URL";
}

function descriptionTree(descriptions: readonly Description[], depth: number): string[] {
  const lines: string[] = [];
  for (const description of descriptions) {
    lines.push(`${"  ".repeat(depth)}${description.key}`);
    lines.push(...descriptionTree(description.children(), depth + 1));
  }
  return lines;
}

/** The trace, as the lines a person reads. */
export function printTrace(trace: Trace): readonly string[] {
  return [
    "1. decoded route",
    `   ${trace.decoded}`,
    "2. resolved against the model",
    ...trace.resolved.map((line) => `   ${line}`),
    "3. keyed component description",
    ...trace.described.map((line) => `   ${line}`),
    "4. mounted Freedom tree",
    ...trace.mounted.map((line) => `   ${line}`),
    "   focus chain",
    ...trace.focus.map((line) => `     ${line}`),
    "5. action delivery",
    ...trace.delivery.map((line) => `   ${line}`),
    "6. branch teardown",
    ...trace.teardown.map((line) => `   ${line}`),
    "7. terminal output",
    ...trace.output.map((line) => `   ${line}`),
  ];
}
