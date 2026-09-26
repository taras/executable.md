/**
 * One real XMD execution, in the topology Slice 2 asks for.
 *
 *     session owner
 *     ├── controller sibling        acquires the gate; outside the target
 *     ├── unrelated live sibling    keeps advancing while the target is held
 *     └── execution scope           REPL middleware installed here, before the run
 *         └── executeInstalled(...) the document and every descendant
 *
 * The document is representative rather than convenient. It exercises the root
 * document, a declared-Markdown component, function components, projected
 * content, a code-block modifier, a bound `exec`, structural syntax the REPL's
 * own profile declares and expands, concurrent descendants, and an operation
 * whose work happens outside Effection.
 *
 * `bypass` swaps one component's body for the same work written as plain
 * Effection with a spawned child of its own — a legitimate-looking descendant
 * that advances without re-entering any controlled surface. It is the named
 * negative control. `withoutMiddleware` installs no REPL decoration at all.
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
  /** One descendant advances without re-entering a controlled surface. */
  readonly bypass?: boolean;
  /** Install no REPL middleware at all. */
  readonly withoutMiddleware?: boolean;
  /** A promise a component body awaits, already in flight. */
  readonly pending?: Promise<string>;
  /** `<Slow>` fails after its ordinary work instead of returning. */
  readonly failing?: boolean;
}

export interface XmdFixture {
  readonly gate: ReplGate | undefined;
  readonly stream: InMemoryStream;
  readonly execution: Task<Json>;
  readonly advances: Signal<Advance, never>;
  journalKinds(): Operation<string[]>;
  /** Steps of ordinary work `<Slow>` completed between two boundaries. */
  slowSteps: () => number;
  /** Steps the bypassing spawned child completed. */
  bypassSteps: () => number;
  /** Elements the document reached after `<Slow>`. */
  afterSlow: () => number;
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

<Slow as="slow" />

<Fanout as="fanout" />

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

/**
 * The REPL's own expansion handler.
 *
 * Reading a region chunk by chunk is the REPL's own loop, so a pause point
 * between two chunks is the REPL's to place — this is not a component author
 * remembering a checkpoint. It covers the regions of syntax *this profile*
 * declared and nothing else: the engine's walk of ordinary prose and of core
 * structural syntax never reaches here.
 */
function replExpansion(
  checkpoint: (label: string) => Operation<void>,
): (request: ExpansionRequest) => Operation<void> {
  return function* expand(request: ExpansionRequest): Operation<void> {
    for (const region of request.regions) {
      const subscription = yield* yield* region.expand();
      while (true) {
        yield* checkpoint(`region:${region.name}`);
        const next = yield* subscription.next();
        if (next.done) {
          break;
        }
      }
    }
  };
}

export function* startXmdFixture(options: XmdFixtureOptions = {}): Operation<XmdFixture> {
  const session = yield* useScope();
  const advances = createSignal<Advance, never>();
  const counts = { sibling: 0, slow: 0, bypass: 0, afterSlow: 0, pastExternal: 0 };
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

  const gate = options.withoutMiddleware
    ? undefined
    : yield* useReplGate({ target: executionScope });

  const slow = {
    name: "Slow",
    origin: REPL_ORIGIN,
    props: { type: "object", properties: {}, additionalProperties: false },
    *fn(): Operation<unknown> {
      if (options.bypass) {
        // A legitimate-looking body: ordinary Effection, with a spawned child
        // of its own that outlives nothing and asks the engine for nothing.
        yield* spawn(function* bypassing() {
          for (let count = 1; ; count += 1) {
            yield* sleep(TICK);
            counts.bypass += 1;
            advances.send({ owner: "bypass", count });
          }
        });
        yield* sleep(TICK * 40);
        return "bypassed";
      }
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

  const fanout = {
    name: "Fanout",
    origin: REPL_ORIGIN,
    props: { type: "object", properties: {}, additionalProperties: false },
    *fn(): Operation<unknown> {
      counts.afterSlow += 1;
      const done = createSignal<string, never>();
      const seen: string[] = [];
      // Slow enough, and announced, so a pause can be requested while both are
      // live and their settling can be observed rather than assumed.
      for (const branch of ["a", "b"]) {
        yield* spawn(function* concurrentChild() {
          for (let step = 1; step <= 6; step += 1) {
            yield* sleep(TICK);
            advances.send({ owner: `fanout:${branch}`, count: step });
          }
          done.send(branch);
        });
      }
      const arriving = yield* done;
      while (seen.length < 2) {
        const next = yield* arriving.next();
        if (!next.done) {
          seen.push(next.value);
        }
      }
      return seen.toSorted().join("+");
    },
  };

  /**
   * A component that retains a resource at its invocation site.
   *
   * `Component.retain` is XMD's own way for a component to own something that
   * outlives its body, so its release is the cleanup this experiment watches on
   * every terminal path — completion, failure, interruption and owner shutdown.
   */
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
    yield* registerComponents([slow, fanout, projecting, holder]);

    if (gate) {
      // Before the execution starts. Never when Pause is pressed.
      yield* gate.installBoundaries();
    }

    const expansion = replExpansion(
      gate
        ? (label) => gate.checkpoint(label)
        : // deno-lint-ignore require-yield
          function* () {
            return;
          },
    );

    return yield* collect(
      yield* executeInstalled({ ...inlineSource(DOCUMENT), stream }, [
        replProfile(gate ? gate.decorateExpand(expansion) : expansion),
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
    slowSteps: () => counts.slow,
    bypassSteps: () => counts.bypass,
    afterSlow: () => counts.afterSlow,
    pastExternal: () => counts.pastExternal,
    lifecycle: () => [...lifecycle],
    *shutdown() {
      yield* disposeExecution();
    },
  };
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
