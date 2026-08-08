/** Public replay-time eval reconstruction modifier. */

import { createContext } from "effection";
import { ephemeral } from "@executablemd/durable-streams";
import type { ModifierFactory } from "../modifiers.ts";

export const EphemeralEval = createContext<boolean>("component.ephemeral-eval", false);

export class EphemeralEvalOutputError extends Error {
  override name = "EphemeralEvalOutputError";
}

export const ephemeralFactory: ModifierFactory = (_params) => (_args, next) =>
  (function* () {
    return yield* ephemeral(EphemeralEval.with(true, () => ephemeral(next())));
  })();
