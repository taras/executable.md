/**
 * The exploit, attempted from outside, in an environment of the suite's making.
 *
 * A package that imported the published entrypoint would do exactly this: look
 * for a factory that builds a Git host, open a session for a locator, and read
 * what the session hands the command. So this program does it — through the bare
 * specifier a stranger would use, not a source-relative path — and says only
 * which of three things happened.
 *
 * It is a separate process because of what the attempt would do if it worked.
 * `denoRepositoryHost` with its own defaults asks the *invoking* environment for
 * a credential, and in-process that environment is the developer's: their home,
 * their helpers, their keychain. A regression in the exports must not become a
 * test that queries a real credential store. Here the environment is the
 * suite's isolated home and nothing else, so the worst a reachable factory can
 * do is ask a helper the suite wrote.
 *
 * Nothing about a credential is read, compared, printed or returned. The whole
 * output is one word.
 */

import process from "node:process";
import { main, type Operation } from "effection";
import * as published from "@executablemd/workflow/deno";

/** What the attempt found. The whole of what this program says. */
const ABSENT = "absent";
const REACHED = "reached";
const REFUSED = "refused";

/** Whether this value can be called as the factory would be. */
function isFactory(value: unknown): value is (options: unknown) => unknown {
  return typeof value === "function";
}

/** Whether this value exposes the session route a host would open. */
function opensSessions(value: unknown): value is {
  useAuthentication(locator: string): Operation<unknown>;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "useAuthentication") === "function"
  );
}

/** Whether what came back is a session with something to attach. */
function attaches(value: unknown): boolean {
  return (
    typeof value === "object" && value !== null && Reflect.get(value, "attachment") !== undefined
  );
}

await main(function* () {
  const [locator, modulePath] = process.argv.slice(2);
  const factory = Reflect.get(published, "denoRepositoryHost");
  if (!isFactory(factory)) {
    process.stdout.write(ABSENT);
    return;
  }

  try {
    // The real source assembly, so a reachable factory is exercised the way a
    // host would exercise it rather than in a shape that could not work anyway.
    const host = factory({
      helper: {
        runtime: "source",
        platform: "unix",
        execPath: process.execPath,
        modulePath,
      },
    });
    if (!opensSessions(host)) {
      process.stdout.write(REFUSED);
      return;
    }
    const opened = yield* host.useAuthentication(locator);
    // That it exists at all is the finding. What it holds is never looked at.
    process.stdout.write(attaches(opened) ? REACHED : REFUSED);
  } catch {
    process.stdout.write(REFUSED);
  }
});
