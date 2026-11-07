/**
 * Hold the enclosing test's teardown until a file exists, then fail it.
 *
 * The task is started in the test's own eval scope, so it is dismantled with
 * the test rather than with this component — which is what makes its failure a
 * teardown failure of the test. `started` is written once teardown begins and
 * `release` is what the suite creates to let it finish.
 */

import { exists, writeTextFile } from "@effectionx/fs";
import { Test } from "@executablemd/testing";
import { cwd } from "@executablemd/runtime";
import type { Json } from "@executablemd/core";
import { ensure, sleep, spawn, suspend } from "effection";
import type { Operation } from "effection";
import { join } from "node:path";

export const props = {
  type: "object",
  properties: { started: { type: "string" }, release: { type: "string" } },
  required: ["started", "release"],
  additionalProperties: false,
};

export default function* HeldTeardown(elementProps: Record<string, Json>): Operation<string> {
  const { started, release } = elementProps;
  if (typeof started !== "string" || typeof release !== "string") {
    throw new Error("HeldTeardown needs its started and release file names");
  }
  const directory = yield* cwd();
  const scope = yield* Test.operations.testScope;
  if (scope === undefined) {
    throw new Error("HeldTeardown belongs inside a <Test>");
  }
  const held = yield* scope.eval(() =>
    spawn(function* () {
      yield* ensure(function* () {
        yield* writeTextFile(join(directory, started), "");
        while (!(yield* exists(join(directory, release)))) {
          yield* sleep(20);
        }
        throw new Error("teardown failed after release");
      });
      yield* suspend();
    }),
  );
  if (!held.ok) {
    throw held.error;
  }
  return "";
}
