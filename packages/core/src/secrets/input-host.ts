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
  const secretInputs = yield* createInputOwner(flush);
  const values = inspectInputOwner(secretInputs);
  let out = values.text();
  let err = values.text();
  const stdout = new TextDecoder();
  const stderr = new TextDecoder();
  const encoder = new TextEncoder();
  const projectedTails = new Set<Uint8Array>();
  function* publish(channel: "stdout" | "stderr", text: string): Operation<void> {
    const bytes = encoder.encode(text);
    projectedTails.add(bytes);
    try {
      yield* Stdio.operations[channel](bytes);
    } finally {
      projectedTails.delete(bytes);
    }
  }
  function* flush(): Operation<void> {
    const outTail = out.write(stdout.decode()) + out.finish();
    const errTail = err.write(stderr.decode()) + err.finish();
    out = values.text();
    err = values.text();
    // Command completion drains through its still-live route; host teardown
    // resolves the host's own downstream rather than a captured command chain.
    if (outTail !== "") {
      yield* publish("stdout", outTail);
    }
    if (errTail !== "") {
      yield* publish("stderr", errTail);
    }
  }
  yield* ensure(flush);
  yield* Stdio.around({
    *stdout([bytes], next) {
      if (projectedTails.has(bytes)) {
        return yield* next(bytes);
      }
      const text = out.write(stdout.decode(bytes, { stream: true }));
      if (text !== "") {
        yield* next(encoder.encode(text));
      }
    },
    *stderr([bytes], next) {
      if (projectedTails.has(bytes)) {
        return yield* next(bytes);
      }
      const text = err.write(stderr.decode(bytes, { stream: true }));
      if (text !== "") {
        yield* next(encoder.encode(text));
      }
    },
  });
  return { secretInputs };
}
