/**
 * Untyped JavaScript boundary fixture. Models a plain-JavaScript consumer
 * that installs a Config timeout middleware with a value that is not a
 * number — the case ConfigApi's TypeScript type forbids, but which the
 * runtime validation must still reject. Deliberately untyped so the invalid
 * value reaches `yield* timeout` without any TypeScript assertion in the
 * test.
 */
import { Config } from "@executablemd/core";

export function* installInvalidTimeout(value) {
  yield* Config.around({ timeout: () => value }, { at: "min" });
}
