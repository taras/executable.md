/**
 * The documented command.
 *
 *   deno task repl:compose --journey
 *   deno task repl:compose --trace 'xmd://repl/e1/transcript/entry-1/document/+project/+confirm?at=cp-10&inspect'
 *
 * `--journey` runs the representative journey with nobody watching: it walks a
 * sequence of locations, advances the clock between them, and prints what the
 * mounted tree drew at each one. `--trace` follows a single location through
 * every layer and prints the seven things #840 asks for.
 *
 * Neither attaches a terminal. The host here measures a viewport from flags
 * rather than from a device, which is the point: the host boundary is the same
 * either way, and none of what it drives knows the difference.
 */

import { main } from "effection";
import type { Operation } from "effection";

import { useRoot } from "../repl-study/vendor/freedom/upstream/index.ts";

import { useFrameClock } from "./frames.ts";
import { EXECUTION, projectModel } from "./history.ts";
import { createHost } from "./host.ts";
import { framedRenderer, plainRenderer } from "./render.ts";
import { decodeRoute, resolveRoute } from "./router.ts";
import { describeScreen } from "./screen.ts";
import type { SessionSnapshot, Viewport } from "./screen.ts";
import { printTrace, traceLocation } from "./trace.ts";

/** The journey: open a drawer, stack one on it, close it, and go nowhere real. */
const JOURNEY: readonly { readonly at: string; readonly url: string }[] = [
  { at: "the entry, no drawer", url: "xmd://repl/e1/transcript/entry-1/document?at=cp-10&inspect" },
  {
    at: "the project drawer",
    url: "xmd://repl/e1/transcript/entry-1/document/+project?at=cp-10&inspect",
  },
  {
    at: "confirm stacked on it",
    url: "xmd://repl/e1/transcript/entry-1/document/+project/+confirm?at=cp-10&inspect",
  },
  {
    at: "the top drawer closed",
    url: "xmd://repl/e1/transcript/entry-1/document/+project?at=cp-10&inspect",
  },
  {
    at: "a location the execution never went to",
    url: "xmd://repl/e1/transcript/entry-1/document/+review?at=cp-10&inspect",
  },
];

const SESSION: SessionSnapshot = { scroll: {} };
const WIDE: Viewport = { columns: 120, rows: 30 };
const NARROW: Viewport = { columns: 72, rows: 20 };

function* run(argv: readonly string[]): Operation<void> {
  const model = projectModel(EXECUTION);
  const root = yield* useRoot();
  const clock = yield* useFrameClock();
  const narrow = argv.includes("--narrow");
  const host = createHost({
    root,
    clock,
    renderer: argv.includes("--framed") ? framedRenderer : plainRenderer,
    viewport: narrow ? NARROW : WIDE,
  });

  const traceAt = argv.indexOf("--trace");
  if (traceAt !== -1) {
    const url = argv[traceAt + 1];
    if (url === undefined) {
      console.error("--trace needs the location to follow");
      return;
    }
    const trace = yield* traceLocation(
      url,
      "xmd://repl/e1/transcript/entry-1/document?at=cp-10&inspect",
      model,
      host,
      root,
      clock,
      SESSION,
      host.viewport,
    );
    for (const line of printTrace(trace)) {
      console.log(line);
    }
    return;
  }

  let elapsed = 0;
  for (const step of JOURNEY) {
    const decoded = decodeRoute(step.url);
    const outcome = decoded.ok ? resolveRoute(decoded.value, model) : decoded;
    const shown = yield* host.show(describeScreen(outcome, SESSION, host.viewport));
    if (!shown.ok) {
      console.error(`refused to compose: ${shown.error.message}`);
      return;
    }
    elapsed += 16;
    yield* host.advance(elapsed);

    console.log(`— ${step.at} —`);
    console.log(host.draw());
    console.log(`frames wanted: ${clock.demand}`);
    console.log("");
  }

  // The renderer is replaced while the same tree stays mounted.
  host.use(framedRenderer);
  console.log("— the same tree, another renderer —");
  console.log(host.draw());
}

if (import.meta.main) {
  await main(() => run(Deno.args));
}
