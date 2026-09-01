/**
 * Untyped JavaScript boundary fixture. Models a plain-JavaScript consumer
 * that installs a Config middleware with a value of the wrong type — the case
 * ConfigApi's TypeScript type forbids, but which the runtime validation must
 * still reject. Deliberately untyped so the invalid value reaches the
 * validated operation without any TypeScript assertion in the test.
 */
import { Config } from "@executablemd/core";

export function* installInvalidTimeout(value, field = "timeout") {
  yield* Config.around({ [field]: () => value }, { at: "min" });
}

export function* installInvalidVerbose(value) {
  yield* Config.around({ verbose: () => value }, { at: "min" });
}
