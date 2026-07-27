import { ensure, scoped } from "effection";
import type { Operation } from "effection";

declare function rm(path: string): Operation<void>;
declare function body(): Operation<void>;
declare function open(dir: string): Operation<{ close(): void }>;

function* registersCleanupBeforeTheWork(dir: string): Operation<void> {
  yield* ensure(() => rm(dir));

  yield* body();
}

function* keepsCleanupInsideTheHelpersOwnScope(dir: string): Operation<void> {
  yield* scoped(function* () {
    yield* ensure(() => rm(dir));

    yield* body();
  });
}

function* closesSynchronouslyWhileUnwinding(dir: string): Operation<void> {
  const handle = yield* open(dir);

  try {
    yield* body();
  } finally {
    handle.close();
  }
}

function* collectsAGeneratorDeclaredWhileUnwinding(
  dir: string,
  cleanups: (() => Operation<void>)[],
): Operation<void> {
  try {
    yield* body();
  } finally {
    cleanups.push(function* () {
      yield* rm(dir);
    });
  }
}

export {
  closesSynchronouslyWhileUnwinding,
  collectsAGeneratorDeclaredWhileUnwinding,
  keepsCleanupInsideTheHelpersOwnScope,
  registersCleanupBeforeTheWork,
};
