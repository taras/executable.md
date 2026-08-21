import type { Operation } from "effection";

declare function rm(path: string): Operation<void>;
declare function close(handle: string): Operation<void>;
declare function paths(): string[];
declare function body(): Operation<void>;
declare function ready(): boolean;
declare function record(event: unknown): Operation<void>;

function* removesAfterTheBody(dir: string): Operation<void> {
  try {
    yield* body();
  } finally {
    yield* rm(dir);
  }
}

function* awaitsAValueWhileUnwinding(handle: string): Operation<void> {
  try {
    yield* body();
  } finally {
    const settled = yield close(handle);
    void settled;
  }
}

function* cleansUpThroughControlFlow(dir: string): Operation<void> {
  try {
    yield* body();
  } finally {
    if (ready()) {
      yield* rm(dir);
    }

    for (const path of paths()) {
      yield* rm(path);
    }
  }
}

function* reportsTheGuardedCleanupOfANestedTry(dir: string): Operation<void> {
  try {
    yield* body();
  } finally {
    try {
      yield* record({ removing: dir });
    } catch {
      yield* record({ failed: dir });
    } finally {
      yield* rm(dir);
    }
  }
}

export {
  awaitsAValueWhileUnwinding,
  cleansUpThroughControlFlow,
  removesAfterTheBody,
  reportsTheGuardedCleanupOfANestedTry,
};

/**
 * The shape that reached `main` in PR #518's probe fixture: one suspending
 * cleanup inside a `finally`, wrapped in a `try`/`catch` that swallows
 * whatever it throws. Swallowing the failure does not make the suspension
 * safe — a halt still abandons the cleanup partway.
 */
function* swallowsTheFailureOfASuspendingCleanup(handle: string): Operation<void> {
  try {
    yield* body();
  } finally {
    try {
      yield* close(handle);
    } catch {
      // deliberately ignored
    }
  }
}

export { swallowsTheFailureOfASuspendingCleanup };
