/**
 * Compile the `xmd` binary from the one canonical set of inputs.
 *
 * Usage:
 *   deno run --allow-all --node-modules-dir=none --cached-only --frozen \
 *     scripts/compile.ts --output dist/xmd [--target <triple>]
 *
 * `deno task build` and `release.yml`'s matrix both reach `deno compile` through
 * here, so neither states a list of embedded assets of its own and the two
 * cannot drift apart. What each supplies is the pair that genuinely differs
 * between them: the output path, and — for a release job — the platform.
 *
 * `verify:clean` builds the same argv from `scripts/lib/compile.ts` directly,
 * because it spawns its phases inside a clone of `HEAD` rather than in this
 * checkout.
 */

import { exit, main } from "effection";

import { compile } from "./lib/compile.ts";
import { RELEASE_TARGETS } from "./lib/release-targets.ts";

const USAGE = "usage: scripts/compile.ts --output <path> [--target <triple>]";

interface Request {
  output?: string;
  target?: string;
}

/**
 * Read the argv, refusing anything it does not define.
 *
 * An unrecognized flag is a refusal rather than something to ignore: this
 * command's whole purpose is that the inputs are not restated per site, and a
 * silently dropped `--target` would compile the runner's own platform and
 * upload it under another platform's artifact name.
 */
function parse(args: readonly string[]): Request | Error {
  const request: Request = {};
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag !== "--output" && flag !== "--target") {
      return new Error(`unrecognized argument ${flag}\n${USAGE}`);
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      return new Error(`${flag} needs a value\n${USAGE}`);
    }
    if (flag === "--output") {
      request.output = value;
    } else {
      request.target = value;
    }
    index += 1;
  }
  return request;
}

main(function* (args) {
  const request = parse(args);
  if (request instanceof Error) {
    console.error(request.message);
    yield* exit(1);
    return;
  }
  const output = request.output;
  if (output === undefined) {
    console.error(`--output is required\n${USAGE}`);
    yield* exit(1);
    return;
  }
  if (request.target !== undefined && !RELEASE_TARGETS[request.target]) {
    console.error(
      `unknown release target "${request.target}" — expected one of ${Object.keys(
        RELEASE_TARGETS,
      ).join(", ")}`,
    );
    yield* exit(1);
    return;
  }

  console.log(`▸ compiling ${output}${request.target ? ` for ${request.target}` : ""}`);
  yield* compile(request.target === undefined ? { output } : { output, target: request.target });
});
