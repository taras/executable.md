/**
 * The documented command.
 *
 *   deno task repl:study --play               the whole story, start to finish
 *   deno task repl:study                      one moment, in this terminal
 *   deno task repl:study --frame 07           one frame of the focus study
 *   deno task repl:study --route <url>        any location, said as a URL
 *   deno task repl:study --focus-map          open with the numbered overlay on
 *   deno task repl:study --capture <dir>      every fixture at every profile
 *   deno task repl:study --print nested wide  one frame, as text
 *   deno task repl:study --replay             the lifecycle, with no terminal
 *
 * `scripts/repl-study/README.md` explains the keys and what each mode is for.
 */

import { ensure, exit, main } from "effection";
import type { Operation } from "effection";

import { captureAll, captureFocus, PROFILE_SIZES, renderFrame, writeCaptures } from "./capture.ts";
import { frame as studyFrame, FRAMES } from "./frames.ts";
import { parseRoute } from "./route.ts";
import { fixture } from "./fixtures.ts";
import { runInteractive, runReplay } from "./host.ts";
import type { TraceEntry } from "./host.ts";
import { JOURNEY, playbackBetween } from "./playback.ts";
import type { Playback } from "./playback.ts";
import { writeTextFile } from "@effectionx/fs";
import { isFixtureName } from "./model.ts";
import type { FixtureName } from "./model.ts";
import type { Profile } from "./layout.ts";
import { isMutation } from "./mutations.ts";
import type { Mutation } from "./mutations.ts";
import { initialView } from "./store.ts";

const USAGE = [
  "usage:",
  "  repl-study [--fixture <name>] [--mutation <name>]",
  "  repl-study --play                       the whole story, start to finish",
  "  repl-study --play <from> <to>           one transition, as a diagnostic",
  "      [--frames <n>] [--interrupt-after-frames <n>] [--trace <file>]",
  "  repl-study --frame <id>                 one frame of the approved focus study",
  "  repl-study --route <url>                one location, said as a URL",
  "  repl-study [--frame <id>] --focus-map   with the numbered focus map drawn",
  "  repl-study --capture <directory> [--mutation <name>]",
  "  repl-study --capture-focus <directory>  the focus study's frames, as text",
  "  repl-study --print <fixture> <profile> [--mutation <name>]",
  "  repl-study --replay [--interrupt-after <n>] [--fail-after <n>] [--mutation <name>]",
  "",
  "fixtures: empty, nested, generated, drawer, paused, settled",
  "profiles: wide, medium, narrow, too-small",
  "playbacks: empty→nested, nested→generated, generated→drawer, drawer→paused, paused→settled",
  `frames: ${FRAMES.map((one) => one.id).join(", ")}`,
].join("\n");

type Mode =
  | {
      readonly kind: "interactive";
      readonly fixture: FixtureName;
      readonly play?: Playback;
      readonly journey?: boolean;
      readonly maxFrames?: number;
      readonly interruptAfterFrames?: number;
      readonly trace?: string;
      readonly route?: string;
      readonly head?: string;
      readonly focus?: string;
      readonly focusMap?: boolean;
    }
  | { readonly kind: "capture"; readonly directory: string; readonly focus?: boolean }
  | { readonly kind: "print"; readonly fixture: FixtureName; readonly profile: Profile }
  | { readonly kind: "replay"; readonly interruptAfter?: number; readonly failAfter?: number };

interface Invocation {
  readonly mode: Mode;
  readonly mutation?: Mutation;
}

function isFrameCount(value: string | undefined): value is string {
  return value !== undefined && Number.isInteger(Number(value)) && Number(value) >= 1;
}

function isProfile(value: string): value is Profile {
  return value === "wide" || value === "medium" || value === "narrow" || value === "too-small";
}

/**
 * Read the command line, refusing anything it does not understand.
 *
 * An unknown option is a refusal rather than a default, because a harness that
 * silently ignored `--mutation stale-frme` would report a passing run for a
 * control that never ran.
 */
export function parse(argv: readonly string[]): Invocation | string {
  let mutation: Mutation | undefined;
  let fixtureName: FixtureName = "nested";
  let mode: Mode | undefined;
  let play: Playback | undefined;
  let journey = false;
  let maxFrames: number | undefined;
  let interruptAfterFrames: number | undefined;
  let trace: string | undefined;
  let route: string | undefined;
  let head: string | undefined;
  let focus: string | undefined;
  let focusMap = false;
  let at = 0;

  const value = (): string | undefined => {
    at += 1;
    return argv[at];
  };

  while (at < argv.length) {
    const argument = argv[at];
    if (argument === "--mutation") {
      const name = value();
      if (name === undefined || !isMutation(name)) {
        return `--mutation needs one of the declared controls, not ${JSON.stringify(name)}`;
      }
      mutation = name;
    } else if (argument === "--fixture") {
      const name = value();
      if (name === undefined || !isFixtureName(name)) {
        return `--fixture needs a fixture name, not ${JSON.stringify(name)}`;
      }
      fixtureName = name;
    } else if (argument === "--capture") {
      const directory = value();
      if (directory === undefined) {
        return "--capture needs a directory to write into";
      }
      mode = { kind: "capture", directory };
    } else if (argument === "--print") {
      const name = value();
      const profile = value();
      if (name === undefined || !isFixtureName(name)) {
        return `--print needs a fixture name, not ${JSON.stringify(name)}`;
      }
      if (profile === undefined || !isProfile(profile)) {
        return `--print needs a profile, not ${JSON.stringify(profile)}`;
      }
      mode = { kind: "print", fixture: name, profile };
    } else if (argument === "--play") {
      // Bare `--play` is the demonstration: the whole story, in order, with
      // nobody at the keyboard. Two fixture names narrow it to one transition,
      // which is a diagnostic rather than the thing to show somebody.
      const from = argv[at + 1];
      const to = argv[at + 2];
      if (from === undefined || from.startsWith("--")) {
        journey = true;
      } else {
        at += 2;
        if (!isFixtureName(from) || to === undefined || !isFixtureName(to)) {
          return `--play takes no arguments, or two fixture names — not ${JSON.stringify([
            from,
            to,
          ])}`;
        }
        const found = playbackBetween(from, to);
        if (found === undefined) {
          return `there is no playback from ${from} to ${to}`;
        }
        play = found;
      }
    } else if (argument === "--frames") {
      const count = value();
      if (!isFrameCount(count)) {
        return "--frames needs a frame count";
      }
      maxFrames = Number(count);
    } else if (argument === "--interrupt-after-frames") {
      const count = value();
      if (!isFrameCount(count)) {
        return "--interrupt-after-frames needs a frame count";
      }
      interruptAfterFrames = Number(count);
    } else if (argument === "--trace") {
      const path = value();
      if (path === undefined) {
        return "--trace needs a file to write";
      }
      trace = path;
    } else if (argument === "--frame") {
      const id = value();
      const found = id === undefined ? undefined : studyFrame(id);
      if (found === undefined) {
        return `--frame needs one of ${FRAMES.map((one) => one.id).join(", ")}, not ${JSON.stringify(id)}`;
      }
      route = found.url;
      head = found.head;
      focus = found.focus;
      fixtureName = found.fixture;
    } else if (argument === "--route") {
      const url = value();
      const parsed = url === undefined ? undefined : parseRoute(url);
      if (parsed === undefined) {
        return "--route needs a REPL URL";
      }
      if (!parsed.ok) {
        return parsed.error.message;
      }
      route = url;
    } else if (argument === "--focus-map") {
      focusMap = true;
    } else if (argument === "--capture-focus") {
      const directory = value();
      if (directory === undefined) {
        return "--capture-focus needs a directory to write into";
      }
      mode = { kind: "capture", directory, focus: true };
    } else if (argument === "--replay") {
      mode = { kind: "replay" };
    } else if (argument === "--interrupt-after" || argument === "--fail-after") {
      const count = Number(value());
      if (!Number.isInteger(count) || count < 1) {
        return `${argument} needs a frame count`;
      }
      const replay = mode?.kind === "replay" ? mode : { kind: "replay" as const };
      mode =
        argument === "--interrupt-after"
          ? { ...replay, interruptAfter: count }
          : { ...replay, failAfter: count };
    } else if (argument === "--help" || argument === "-h") {
      return USAGE;
    } else {
      return `unknown option ${JSON.stringify(argument)}\n\n${USAGE}`;
    }
    at += 1;
  }

  return {
    mode: mode ?? {
      kind: "interactive",
      fixture: journey ? "empty" : fixtureName,
      play,
      journey,
      maxFrames,
      interruptAfterFrames,
      trace,
      route,
      head,
      focus,
      focusMap,
    },
    mutation,
  };
}

function* run(invocation: Invocation): Operation<void> {
  const { mode, mutation } = invocation;

  if (mode.kind === "capture") {
    const captures = mode.focus === true ? yield* captureFocus() : yield* captureAll();
    yield* writeCaptures(mode.directory, captures);
    console.log(`wrote ${captures.length} captures to ${mode.directory}`);
    return;
  }

  if (mode.kind === "print") {
    const subject = fixture(mode.fixture);
    const frame = yield* renderFrame({
      fixture: subject,
      view: initialView(subject),
      size: PROFILE_SIZES[mode.profile],
      mutation,
    });
    console.log(frame.text);
    return;
  }

  if (mode.kind === "replay") {
    yield* runReplay({ mutation, interruptAfter: mode.interruptAfter, failAfter: mode.failAfter });
    return;
  }

  if (!Deno.stdout.isTerminal() || !Deno.stdin.isTerminal()) {
    yield* exit(
      2,
      "repl-study needs a real terminal. Use --capture <dir> to write every frame to files, --print <fixture> <profile> for one, or --replay for the lifecycle.",
    );
    return;
  }

  const trace: TraceEntry[] = [];
  const tracePath = mode.trace;
  if (tracePath !== undefined) {
    // Written from teardown, not after the loop: an interruption ends this run
    // through the same shutdown that restores the terminal, and a trace that
    // only survived an ordinary exit could not testify about an interrupted
    // one. Registered before the harness starts, so it runs after it stops.
    yield* ensure(function* () {
      yield* writeTextFile(
        tracePath,
        trace.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
      );
    });
  }
  yield* runInteractive({
    fixture: mode.fixture,
    route: mode.route,
    head: mode.head,
    focus: mode.focus,
    focusMap: mode.focusMap,
    mutation,
    play: mode.play,
    journey: mode.journey === true ? JOURNEY : undefined,
    maxFrames: mode.maxFrames,
    interruptAfterFrames: mode.interruptAfterFrames,
    trace: tracePath === undefined ? undefined : trace,
  });
}

if (import.meta.main) {
  await main(function* () {
    const invocation = parse(Deno.args);
    if (typeof invocation === "string") {
      console.log(invocation);
      yield* exit(invocation === USAGE ? 0 : 2);
      return;
    }
    yield* run(invocation);
  });
}
