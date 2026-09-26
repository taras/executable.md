/**
 * One real XMD execution, in the topology the corrected contract asks for.
 *
 *     session owner
 *     ├── controller sibling        acquires the gate; outside the target
 *     ├── unrelated live sibling    ordinary Effection, never an obligation
 *     └── execution scope           REPL middleware installed here, before the run
 *         └── executeInstalled(...) the document and every descendant
 *
 * The document is representative rather than convenient. It exercises the root
 * document, structural syntax the REPL's own profile declares and expands,
 * declared Markdown, projected content, a component-retained resource, a
 * code-block modifier, a bound `exec`, and document output.
 *
 * Three things here exist to make the *corrected* claims provable:
 *
 * - **`<Fanout>` spawns ordinary Effection children.** They are not expansion, so
 *   they must never prevent `paused`. That is the runtime-independence case.
 * - **`<Background>` starts work that outlives its own invocation** and records a
 *   durable outcome to the same stream the engine journals through. That is how
 *   the Journal head can advance while expansion is held.
 * - **`concurrentRegions` expands the two `<Panel>` regions in parallel**, each
 *   bracketed as its own walk by the REPL's own handler, so "all concurrent walks
 *   held or settled" has something real to be true of.
 */

import {
  createScope,
  createSignal,
  resource,
  scoped,
  sleep,
  spawn,
  until,
  useScope,
} from "effection";
import type { Operation, Signal, Subscription, Task } from "effection";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { DurableEvent } from "@executablemd/durable-streams";
import { useEchoExec } from "@executablemd/runtime/test";

import { collect } from "../../packages/core/src/collect.ts";
import { registerComponents } from "../../packages/core/src/components/registration.ts";
import { content, retain } from "../../packages/core/src/component-api.ts";
import { inlineSource } from "../../packages/core/src/root-source.ts";
import { executeInstalled, Markdown, sourceDigest, Structural } from "../../packages/core/host.ts";
import type { ExecutionInstallation, ExpansionRequest } from "../../packages/core/host.ts";
import type { Json } from "../../packages/core/src/types.ts";

import { useReplGate } from "./repl-gate.ts";
import type { ReplGate } from "./repl-gate.ts";

const REPL_ORIGIN = "repl-pause/profile";

/** Long enough that a loop yields to its siblings, short enough to stay quick. */
const TICK = 1;

export interface Advance {
  readonly owner: string;
  readonly count: number;
}

export interface XmdFixtureOptions {
  /** Install no REPL middleware at all. */
  readonly withoutMiddleware?: boolean;
  /** Expand the two `<Panel>` regions as concurrent walks. */
  readonly concurrentRegions?: boolean;
  /** External work a component body awaits, already in flight. */
  readonly pending?: Promise<string>;
  /** External work a background recorder awaits, already in flight. */
  readonly background?: Promise<string>;
  /** `<Slow>` fails after its ordinary work instead of returning. */
  readonly failing?: boolean;
  /** Let the structural expansion path skip the gate — the bypass control. */
  readonly bypassGate?: boolean;
}

export interface XmdFixture {
  readonly gate: ReplGate | undefined;
  readonly stream: InMemoryStream;
  readonly execution: Task<Json>;
  readonly advances: Signal<Advance, never>;
  journalKinds(): Operation<string[]>;
  /** Durable appends so far, as the stream itself counts them. */
  appendCount: () => number;
  /** How many times a record of this kind was appended, counted at append time. */
  appendsOf: (kind: string) => number;
  /** Steps of ordinary Effection work `<Slow>` completed between boundaries. */
  slowSteps: () => number;
  /** Steps the ordinary spawned children of `<Fanout>` completed. */
  fanoutSteps: () => number;
  /** Whether `<Later>` expanded — the element after the usual pause point. */
  laterRan: () => number;
  /** Whether `<Slow>`'s continuation ran past its external operation. */
  pastExternal: () => number;
  /** Retained resources, in the order they were acquired and released. */
  lifecycle: () => readonly string[];
  /** Destroy the scope that owns the execution — CLI-style owner shutdown. */
  shutdown(): Operation<void>;
}

const GREETING_SOURCE = `Hello from declared Markdown.\n`;

const DOCUMENT = `# REPL target

<Panels>
<Panel title="one">
Panel one body.
</Panel>
<Panel title="two">
Panel two body.
</Panel>
</Panels>

<Greeting />

<Projecting>
Projected content the component asks for.
</Projecting>

<Holder as="held" />

<Background as="background" />

<Fanout as="fanout" />

<Slow as="slow" />

<Later as="later" />

\`\`\`sh exec
echo plain
\`\`\`

\`\`\`sh exec as="bound"
echo bound
\`\`\`
`;

function replProfile(
  expand: (request: ExpansionRequest) => Operation<void>,
): ExecutionInstallation {
  return {
    declarations: [
      Structural({
        name: "Panels",
        origin: REPL_ORIGIN,
        forms: ["paired"],
        props: { type: "object", properties: {}, additionalProperties: false },
        syntax: ["<Panels><Panel>…</Panel></Panels>"],
        description: "Lay out the panels written inside it.",
        context: "The panels this construct lays out.",
        parent: null,
      }),
      Structural({
        name: "Panel",
        origin: REPL_ORIGIN,
        forms: ["paired"],
        props: {
          type: "object",
          properties: { title: { type: "string" } },
          additionalProperties: false,
        },
        syntax: ['<Panel title="one">…</Panel>'],
        description: "One panel.",
        context: "Markdown the panel holds.",
        parent: "Panels",
      }),
      Markdown({
        name: "Greeting",
        origin: `${REPL_ORIGIN}/Greeting`,
        source: GREETING_SOURCE,
        digest: sourceDigest(GREETING_SOURCE),
      }),
    ],
    expand,
  };
}

/** Read one region to completion, as the REPL's handler does. */
function* readRegion(
  region: ExpansionRequest["regions"][number],
  checkpoint: (label: string) => Operation<void>,
  announce: (owner: string) => void,
  pace: number,
): Operation<void> {
  const subscription = yield* yield* region.expand();
  while (true) {
    yield* checkpoint(`region:${region.name}`);
    if (pace > 0) {
      // Paced only so that a pause can arrive while a region is genuinely
      // mid-expansion rather than already finished. An ungated region is paced
      // harder, because the whole point of that control is a path that is *still
      // expanding* when the controller is asked to settle.
      yield* sleep(TICK * pace);
    }
    announce("region");
    const next = yield* subscription.next();
    if (next.done) {
      return;
    }
  }
}

/**
 * The REPL's own expansion handler.
 *
 * A region is an expansion unit this REPL delimits itself, so each one is
 * bracketed as its own walk. Expanded in parallel that makes two concurrent
 * walks, which is the only honest way to have concurrent expansion to test.
 */
function replExpansion(
  gate: ReplGate | undefined,
  concurrent: boolean,
  announce: (owner: string) => void = () => {},
  pace = 0,
): (request: ExpansionRequest) => Operation<void> {
  const checkpoint = gate
    ? (label: string) => gate.checkpoint(label)
    : // deno-lint-ignore require-yield
      function* (): Operation<void> {
        return;
      };
  const walk = gate
    ? <T>(detail: string, body: () => Operation<T>) => gate.walk("region", detail, body)
    : <T>(_detail: string, body: () => Operation<T>) => body();

  return function* expand(request: ExpansionRequest): Operation<void> {
    if (concurrent) {
      const running: Task<void>[] = [];
      for (const region of request.regions) {
        running.push(
          yield* spawn(() =>
            walk(region.name, () => readRegion(region, checkpoint, announce, pace)),
          ),
        );
      }
      for (const task of running) {
        yield* task;
      }
      return;
    }
    for (const region of request.regions) {
      yield* walk(region.name, () => readRegion(region, checkpoint, announce, pace));
    }
  };
}

export function* startXmdFixture(options: XmdFixtureOptions = {}): Operation<XmdFixture> {
  const session = yield* useScope();
  const advances = createSignal<Advance, never>();
  const counts = { sibling: 0, slow: 0, fanout: 0, later: 0, pastExternal: 0 };
  const lifecycle: string[] = [];

  yield* spawn(function* unrelatedSibling() {
    for (let count = 1; ; count += 1) {
      yield* sleep(TICK);
      counts.sibling += 1;
      advances.send({ owner: "sibling", count });
    }
  });

  // Destructured so the owner can be torn down explicitly, which is what a
  // CLI-style shutdown does to a running execution.
  const [executionScope, disposeExecution] = createScope(session);
  const stream = new InMemoryStream();
  // Counted as each append happens, so a duplicate is caught whenever it lands
  // rather than only if a test samples the journal at the right moment.
  const appendsByKind = new Map<string, number>();
  stream.onAppend = (event) => {
    const kind = event.type === "yield" ? `yield:${String(event.description.type)}` : event.type;
    appendsByKind.set(kind, (appendsByKind.get(kind) ?? 0) + 1);
  };

  const gate = options.withoutMiddleware
    ? undefined
    : yield* useReplGate({ target: executionScope });

  /** A component that retains a resource at its invocation site. */
  const holder = {
    name: "Holder",
    origin: REPL_ORIGIN,
    props: { type: "object", properties: {}, additionalProperties: false },
    *fn(): Operation<unknown> {
      return yield* retain(() =>
        resource<string>(function* (provide) {
          lifecycle.push("acquired:held");
          try {
            yield* provide("held-token");
          } finally {
            lifecycle.push("released:held");
          }
        }),
      );
    },
  };

  /**
   * Work that outlives its own invocation and records durably when it finishes.
   *
   * Retained, so the recorder belongs to the document rather than to the element
   * that started it, and it appends to the same durable stream the engine
   * journals through. This is the "already-running work records its outcome"
   * case, and it is what lets the Journal head move while expansion is held at a
   * boundary.
   */
  const background = {
    name: "Background",
    origin: REPL_ORIGIN,
    props: { type: "object", properties: {}, additionalProperties: false },
    *fn(): Operation<unknown> {
      return yield* retain(() =>
        resource<string>(function* (provide) {
          yield* spawn(function* recorder() {
            const value = options.background ? yield* until(options.background) : "none";
            const event: DurableEvent = {
              type: "yield",
              coroutineId: "root.background",
              description: { type: "background", name: "repl-pause.background", label: value },
              result: { status: "ok", value },
            };
            yield* stream.append(event);
            advances.send({ owner: "recorded", count: 1 });
          });
          yield* provide("background-started");
        }),
      );
    },
  };

  const slow = {
    name: "Slow",
    origin: REPL_ORIGIN,
    props: { type: "object", properties: {}, additionalProperties: false },
    *fn(): Operation<unknown> {
      for (let step = 1; step <= 40; step += 1) {
        yield* sleep(TICK);
        counts.slow += 1;
        advances.send({ owner: "slow", count: step });
      }
      if (options.pending) {
        const value = yield* until(options.pending);
        counts.pastExternal += 1;
        return value;
      }
      if (options.failing) {
        throw new Error("Slow failed while the controller was coordinating");
      }
      return "slow-done";
    },
  };

  /**
   * Ordinary Effection descendants of one component invocation.
   *
   * They expand nothing, so they are not pause obligations. Their liveness is
   * exactly what must *not* prevent `paused`.
   */
  const fanout = {
    name: "Fanout",
    origin: REPL_ORIGIN,
    props: { type: "object", properties: {}, additionalProperties: false },
    *fn(): Operation<unknown> {
      return yield* retain(() =>
        resource<string>(function* (provide) {
          for (const branch of ["a", "b"]) {
            yield* spawn(function* ordinaryChild() {
              for (let step = 1; ; step += 1) {
                yield* sleep(TICK);
                counts.fanout += 1;
                advances.send({ owner: `fanout:${branch}`, count: step });
              }
            });
          }
          yield* provide("fanout-live");
        }),
      );
    },
  };

  /** The element the walk reaches after the usual pause point. */
  const later = {
    name: "Later",
    origin: REPL_ORIGIN,
    props: { type: "object", properties: {}, additionalProperties: false },
    // deno-lint-ignore require-yield
    *fn(): Operation<unknown> {
      counts.later += 1;
      return "later-ran";
    },
  };

  const projecting = {
    name: "Projecting",
    origin: REPL_ORIGIN,
    props: { type: "object", properties: {}, additionalProperties: false },
    *fn(): Operation<unknown> {
      const projected = yield* content();
      return projected.trim();
    },
  };

  const execution = executionScope.run(function* replExecution() {
    yield* useEchoExec();
    yield* registerComponents([slow, fanout, projecting, holder, background, later]);

    if (gate) {
      // Before the execution starts. Never when Pause is pressed.
      yield* gate.installBoundaries();
    }

    // `bypassGate` hands the profile an undecorated handler, so the structural
    // expansion path reaches no gate at all. That is the bypass control.
    const expansion = replExpansion(
      options.bypassGate ? undefined : gate,
      options.concurrentRegions ?? false,
      (owner) => advances.send({ owner, count: 1 }),
      options.bypassGate ? 25 : options.concurrentRegions ? 1 : 0,
    );

    return yield* collect(
      yield* executeInstalled({ ...inlineSource(DOCUMENT), stream }, [
        replProfile(gate && !options.bypassGate ? gate.decorateExpand(expansion) : expansion),
      ]),
    );
  });

  return {
    gate,
    stream,
    execution,
    advances,
    *journalKinds() {
      const events = yield* stream.readAll();
      return events.map((event) =>
        event.type === "yield" ? `yield:${String(event.description.type)}` : event.type,
      );
    },
    appendCount: () => stream.appendCount,
    appendsOf: (kind: string) => appendsByKind.get(kind) ?? 0,
    slowSteps: () => counts.slow,
    fanoutSteps: () => counts.fanout,
    laterRan: () => counts.later,
    pastExternal: () => counts.pastExternal,
    lifecycle: () => [...lifecycle],
    *shutdown() {
      yield* disposeExecution();
    },
  };
}

/**
 * One execution outside the selected subtree, run to completion.
 *
 * Its own scope, its own stream, its own profile. Used to show that pausing one
 * execution does not touch another: it expands and records normally while the
 * target is held.
 */
export function* runSiblingExecution(): Operation<{ output: string; journal: string[] }> {
  return yield* scoped(function* () {
    yield* useEchoExec();
    const stream = new InMemoryStream();
    const output = yield* collect(
      yield* executeInstalled(
        {
          ...inlineSource("# Sibling\n\n<Greeting />\n\n```sh exec\necho sibling\n```\n"),
          stream,
        },
        [replProfile(replExpansion(undefined, false))],
      ),
    );
    const events = yield* stream.readAll();
    return {
      output: String(output),
      journal: events.map((event) =>
        event.type === "yield" ? `yield:${String(event.description.type)}` : event.type,
      ),
    };
  });
}

/** Wait until `owner` announces its next advance. */
export function* advanceOf(
  advancing: Subscription<Advance, never>,
  owner: string,
): Operation<Advance> {
  while (true) {
    const next = yield* advancing.next();
    if (!next.done && next.value.owner === owner) {
      return next.value;
    }
  }
}

/** Run one operation in its own scope so its executions cannot outlive it. */
export function isolated<T>(body: () => Operation<T>): Operation<T> {
  return scoped(body);
}
