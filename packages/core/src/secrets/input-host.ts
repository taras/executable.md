import { ensure } from "effection";
import type { Operation } from "effection";
import { Stdio } from "@effectionx/process";
import { createInputOwner, inspectInputOwner } from "./inputs.ts";
import type { ExecutionInstallation } from "../execute.ts";

/**
 * Protect output for one producing run, including its surrounding providers.
 *
 * ```ts
 * const privacy = yield* useSecretInputs();
 * const provider = yield* entryInstallation();
 * const execution = yield* executeInstalled(options, [privacy, provider]);
 * ```
 * The REPL acquires this before entry resources and keeps it until they join.
 * Ordinary CLI execution and the Sidekick conversation use the same factory.
 * One installation attaches to one execution; reusable assembly holds no owner.
 * Hosts need no plaintext collection or extra output log. Core owns projection
 * and disposal, while the host still owns its providers and their joined scope.
 */
export function* useSecretInputs(): Operation<ExecutionInstallation> {
  const secretInputs = yield* createInputOwner();
  const values = inspectInputOwner(secretInputs);
  const out = values.text();
  const err = values.text();
  const stdout = new TextDecoder();
  const stderr = new TextDecoder();
  const encoder = new TextEncoder();
  let sendOut: ((bytes: Uint8Array) => Operation<void>) | undefined;
  let sendErr: ((bytes: Uint8Array) => Operation<void>) | undefined;
  yield* ensure(function* () {
    const outTail = out.write(stdout.decode()) + out.finish();
    const errTail = err.write(stderr.decode()) + err.finish();
    if (outTail !== "" && sendOut !== undefined) {
      yield* sendOut(encoder.encode(outTail));
    }
    if (errTail !== "" && sendErr !== undefined) {
      yield* sendErr(encoder.encode(errTail));
    }
  });
  yield* Stdio.around({
    *stdout([bytes], next) {
      sendOut = next;
      const text = out.write(stdout.decode(bytes, { stream: true }));
      if (text !== "") {
        yield* next(encoder.encode(text));
      }
    },
    *stderr([bytes], next) {
      sendErr = next;
      const text = err.write(stderr.decode(bytes, { stream: true }));
      if (text !== "") {
        yield* next(encoder.encode(text));
      }
    },
  });
  return { secretInputs };
}
