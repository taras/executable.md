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
