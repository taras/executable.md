/**
 * The documented command.
 *
 *   deno task repl:study                      the harness, in this terminal
 *   deno task repl:study --capture <dir>      every fixture at every profile
 *   deno task repl:study --print nested wide  one frame, as text
 *   deno task repl:study --replay             the lifecycle, with no terminal
 *
 * `scripts/repl-study/README.md` explains the keys and what each mode is for.
 */

import { exit, main } from "effection";
import type { Operation } from "effection";

import { captureAll, PROFILE_SIZES, renderFrame, writeCaptures } from "./capture.ts";
import { fixture } from "./fixtures.ts";
import { runInteractive, runReplay } from "./host.ts";
import { isFixtureName } from "./model.ts";
import type { FixtureName } from "./model.ts";
import type { Profile } from "./layout.ts";
import { isMutation } from "./mutations.ts";
import type { Mutation } from "./mutations.ts";
import { initialView } from "./view.ts";

const USAGE = [
  "usage:",
  "  repl-study [--fixture <name>] [--mutation <name>]",
  "  repl-study --capture <directory> [--mutation <name>]",
  "  repl-study --print <fixture> <profile> [--mutation <name>]",
  "  repl-study --replay [--interrupt-after <n>] [--fail-after <n>] [--mutation <name>]",
  "",
  "fixtures: empty, nested, generated, drawer, paused, settled",
  "profiles: wide, medium, narrow, too-small",
].join("\n");

type Mode =
  | { readonly kind: "interactive"; readonly fixture: FixtureName }
  | { readonly kind: "capture"; readonly directory: string }
  | { readonly kind: "print"; readonly fixture: FixtureName; readonly profile: Profile }
  | { readonly kind: "replay"; readonly interruptAfter?: number; readonly failAfter?: number };

interface Invocation {
  readonly mode: Mode;
  readonly mutation?: Mutation;
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

  return { mode: mode ?? { kind: "interactive", fixture: fixtureName }, mutation };
}

function* run(invocation: Invocation): Operation<void> {
  const { mode, mutation } = invocation;

  if (mode.kind === "capture") {
    const captures = yield* captureAll();
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

  yield* runInteractive({ fixture: mode.fixture, mutation });
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
