/** Attached service terminal modifier. */

import { ephemeral } from "@executablemd/durable-streams";
import { unbox } from "@effectionx/scope-eval";
import type { Operation } from "effection";
import { cwd, startService, timeout } from "@executablemd/runtime";
import type { ModifierFactory } from "../modifiers.ts";
import { useCodeBlock } from "../modifiers.ts";
import { env, evalScope } from "../component-api.ts";
import { liveEnvironment, validateServiceBinding } from "../live-env.ts";
import type { CodeBlockResult } from "../types.ts";

export const serviceFactory: ModifierFactory = (params) => (_args, _next) =>
  (function* () {
    const ctx = yield* useCodeBlock();

    const start: Operation<CodeBlockResult> = {
      *[Symbol.iterator]() {
        const durable = yield* env;
        if (!durable) {
          throw new Error(
            "attached service requires a component binding environment; none is in scope.",
          );
        }
        const live = liveEnvironment(durable);
        const binding = validateServiceBinding(params, durable, live);

        const scope = yield* evalScope;
        if (!scope) {
          throw new Error("attached service requires a component eval scope; none is in scope.");
        }

        const directory = yield* cwd();
        const startupTimeout = yield* timeout;
        const attachment = yield* scope.eval(function* () {
          const serviceAttachment = yield* startService({
            command: ctx.content,
            cwd: directory,
            startupTimeout,
          });
          return serviceAttachment.endpoint;
        });
        live.values[binding] = unbox(attachment);
        return { output: "", exitCode: 0, stderr: "" };
      },
    };

    return yield* ephemeral(start);
  })();
