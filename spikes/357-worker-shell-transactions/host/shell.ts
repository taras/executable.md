import { useWorker } from "@effectionx/worker";
import { ensure, on, type Operation, race, scoped, sleep } from "effection";
import type { Workspace } from "./workspace.ts";
import { EffectFsRouter } from "./router.ts";
import type {
  FsCall,
  FsResponse,
  ShellWorkerData,
  ShellWorkerResult,
} from "./shell-worker.ts";
import type { EffectTransaction, JournalEntry } from "./storage.ts";

export type ShellOutcome =
  | "exit"
  | "interpreter-error"
  | "timeout"
  | "cancelled"
  | "terminated"
  | "worker-error";

export interface ShellResult {
  outcome: ShellOutcome;
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ShellEffectResult {
  shell: ShellResult;
  journal: JournalEntry;
  transaction: {
    nestedDofsTransactions: number;
    effectTransactionsBegun: number;
    effectCommits: number;
    effectRollbacks: number;
    journalAppendsInEffect: number;
  };
}

export interface ShellEffectOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
  terminateAfterMs?: number;
  maxCommandCount?: number;
  maxLoopIterations?: number;
  onMutation?: (operation: string) => void;
  onWorkerStart?: () => void;
  beforeCommit?: () => Operation<void>;
}

export interface ReplayResult {
  replayed: boolean;
  journal: JournalEntry;
  shell?: ShellResult;
}

export function* executeShellEffect(
  workspace: Workspace,
  effectId: string,
  command: string,
  filteredJournalPayload: string,
  options: ShellEffectOptions = {},
): Operation<ShellEffectResult> {
  const transaction = workspace.storage.beginEffect(effectId);
  yield* ensure(() => {
    transaction.abort();
  });

  const shell = yield* runShellWorker(
    workspace,
    transaction,
    command,
    options,
  );
  const successful = shell.outcome === "exit" && shell.exitCode === 0;
  if (successful) {
    transaction.acceptMutations();
  } else {
    transaction.discardMutations();
  }
  const status = successful ? "ok" : "failed";
  transaction.appendResult(status, filteredJournalPayload);
  if (options.beforeCommit !== undefined) {
    yield* options.beforeCommit();
  }
  transaction.commit();

  const journal = workspace.storage.readJournal(effectId);
  if (journal === undefined) {
    throw new Error(`committed journal result ${effectId} is missing`);
  }
  return {
    shell,
    journal,
    transaction: workspace.storage.metrics(),
  };
}

export function* replayOrExecuteShellEffect(
  workspace: Workspace,
  effectId: string,
  command: string,
  filteredJournalPayload: string,
  options: ShellEffectOptions = {},
): Operation<ReplayResult> {
  const existing = workspace.storage.readJournal(effectId);
  if (existing !== undefined) {
    return { replayed: true, journal: existing };
  }
  const executed = yield* executeShellEffect(
    workspace,
    effectId,
    command,
    filteredJournalPayload,
    options,
  );
  return {
    replayed: false,
    journal: executed.journal,
    shell: executed.shell,
  };
}

function* runShellWorker(
  workspace: Workspace,
  transaction: EffectTransaction,
  command: string,
  options: ShellEffectOptions,
): Operation<ShellResult> {
  const invocationId = crypto.randomUUID();
  const router = new EffectFsRouter(
    workspace.fs,
    transaction,
    invocationId,
    { onMutation: options.onMutation },
  );
  options.onWorkerStart?.();
  const data: ShellWorkerData = {
    effectId: transaction.effectId,
    invocationId,
    command,
    cwd: options.cwd ?? "/workspace",
    env: options.env ?? {},
    maxCommandCount: options.maxCommandCount,
    maxLoopIterations: options.maxLoopIterations,
  };
  const result = yield* scoped(function* (): Operation<ShellResult> {
    const worker = yield* useWorker<
      never,
      never,
      ShellWorkerResult,
      ShellWorkerData
    >(
      new URL("./shell-worker.ts", import.meta.url),
      {
        type: "module",
        data,
        deno: { permissions: "none" },
      },
    );
    const outcomes: Operation<ShellResult>[] = [
      worker.forEach<FsCall, FsResponse>(function* (call) {
        try {
          const reply = yield* router.route(call);
          return { value: reply.value };
        } catch (error) {
          return { error: serializeError(error) };
        }
      }),
      timeout(options.timeoutMs ?? 5_000),
    ];
    if (options.signal !== undefined) {
      outcomes.push(cancelled(options.signal));
    }
    if (options.terminateAfterMs !== undefined) {
      outcomes.push(terminatedAfter(options.terminateAfterMs));
    }
    return yield* race(outcomes);
  });

  if (result.outcome === "exit" || result.outcome === "interpreter-error") {
    router.complete();
  } else {
    router.cancel();
  }
  return result;
}

function* timeout(milliseconds: number): Operation<ShellResult> {
  yield* sleep(milliseconds);
  return {
    outcome: "timeout",
    stdout: "",
    stderr: "Execution timed out\n",
    exitCode: 124,
  };
}

function* cancelled(signal: AbortSignal): Operation<ShellResult> {
  if (!signal.aborted) {
    const aborts = yield* on(signal, "abort");
    yield* aborts.next();
  }
  return {
    outcome: "cancelled",
    stdout: "",
    stderr: "Execution cancelled\n",
    exitCode: 130,
  };
}

function* terminatedAfter(milliseconds: number): Operation<ShellResult> {
  yield* sleep(milliseconds);
  return {
    outcome: "terminated",
    stdout: "",
    stderr: "Worker terminated\n",
    exitCode: 1,
  };
}

function serializeError(value: unknown): { message: string; code?: string } {
  const serialized: { message: string; code?: string } = {
    message: value instanceof Error ? value.message : String(value),
  };
  if (
    typeof value === "object" && value !== null && "code" in value &&
    typeof value.code === "string"
  ) {
    serialized.code = value.code;
  }
  return serialized;
}
