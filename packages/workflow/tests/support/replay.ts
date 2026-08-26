/**
 * What every Repository and Worktree replay suite needs to see.
 *
 * These reach past the adapter on purpose. A replay claim is about what another
 * process would find, so the observations here open their own connection to the
 * run's database — a row written inside an open transaction is invisible to one
 * until that transaction commits, which is what makes these say whether a commit
 * happened rather than whether a row is there afterwards.
 *
 * The fixtures that damage a run are here for the same reason: no supported
 * operation can produce the states these suites replay from, so they are written
 * past every component that would refuse to produce them.
 */

import { type Operation, until } from "effection";
import { mkdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { RepositoryStaleStateError } from "../../src/composition/errors.ts";
import { WORKSPACE_REPOSITORY, WORKSPACE_WORKTREE } from "../../src/deno/composition/provider.ts";
import { runPath, tamper } from "./storage.ts";
import { compositionEvents } from "./composition.ts";
import type { WorkflowRunDatabase } from "../../src/storage/api.ts";

export const REMOTE = {
  commits: [{ message: "first", entries: [{ path: "which.txt", content: "first\n" }] }],
} as const;

export function source(locator: string, extra = ""): string {
  return [
    `<Repository name="project" url="${locator}">`,
    `<Worktree name="implementation" branch="feature/new" as="worktree" />`,
    "<Dir path={worktree}>",
    `<File path="which.txt" as="which" />`,
    "",
    "inside: {which}",
    "</Dir>",
    extra,
    "</Repository>",
  ].join("\n");
}

/**
 * Take away the root's Close.
 *
 * A completed journal answers with its recorded root result without replaying
 * anything, so a partial replay is what is left when the Close is removed.
 */
export function dropRootClose(path: string): void {
  tamper(path, (database) => {
    let dropped = 0;
    for (const row of database.prepare("SELECT sequence, record FROM journal_events").all()) {
      const parsed: unknown = JSON.parse(String(row["record"]));
      if (typeof parsed !== "object" || parsed === null) {
        continue;
      }
      if (
        Reflect.get(parsed, "type") !== "close" ||
        Reflect.get(parsed, "coroutineId") !== "root"
      ) {
        continue;
      }
      database.prepare("DELETE FROM journal_events WHERE sequence = ?").run(row["sequence"]);
      dropped += 1;
    }
    if (dropped !== 1) {
      throw new Error(`the journal records ${dropped} root closes`);
    }
  });
}

/**
 * How many composition effects another connection can see right now.
 *
 * A second connection rather than the run's own journal handle, because rows
 * written inside an open transaction are invisible to it until that transaction
 * commits — which is what makes this say whether a commit happened rather than
 * whether a row is there afterwards.
 */
export function committedCompositionEvents(path: string): number {
  const database = new DatabaseSync(path);
  try {
    let total = 0;
    for (const row of database.prepare("SELECT record FROM journal_events").all()) {
      const parsed: unknown = JSON.parse(String(row["record"]));
      if (typeof parsed !== "object" || parsed === null) {
        continue;
      }
      const description = Reflect.get(parsed, "description");
      if (typeof description !== "object" || description === null) {
        continue;
      }
      const type = Reflect.get(description, "type");
      if (type === WORKSPACE_REPOSITORY || type === WORKSPACE_WORKTREE) {
        total += 1;
      }
    }
    return total;
  } finally {
    database.close();
  }
}

/** The current root pointer, as a second connection sees it. */
export function committedRoot(path: string): unknown {
  let found: unknown;
  tamper(path, (database) => {
    found = database.prepare("SELECT current_root_id AS root FROM workspace_state").get()?.root;
  });
  return found;
}

/**
 * Damage one retained row, and refuse to continue if it damaged none.
 *
 * A tamper that matched nothing leaves the run healthy, and a regression built
 * on one passes by testing the unmodified case. The row count is what makes the
 * damage a premise rather than an assumption.
 */
export function changedExactlyOne(path: string, sql: string, parameters: string[]): void {
  tamper(path, (database) => {
    const changes = Number(database.prepare(sql).run(...parameters).changes);
    if (changes !== 1) {
      throw new Error(`the tamper changed ${changes} rows`);
    }
  });
}

/**
 * How many Workspace roots this run has published beyond the empty one it began
 * with.
 *
 * A published root is the durable trace of an effect that changed the Workspace.
 * Counting them is how "the refusal published nothing" is observed from outside,
 * without needing to see the root pointer at the instant between two effects.
 */
export function publishedRoots(path: string): number {
  let total = 0;
  tamper(path, (database) => {
    total = Number(database.prepare("SELECT count(*) AS total FROM workspace_roots").get()?.total);
  });
  // The run starts at an empty root, which nothing published.
  return total - 1;
}

/** The most recently published root, as a second connection sees it. */
export function latestRoot(path: string): unknown {
  let found: unknown;
  tamper(path, (database) => {
    found = database
      .prepare("SELECT root_id AS id FROM workspace_roots ORDER BY rowid DESC LIMIT 1")
      .get()?.id;
  });
  return found;
}

/**
 * Damage the checkout path in both places a run keeps it.
 *
 * The retained row and the journaled record are separately authoritative, and
 * the attachment check that compares them already refuses when only one has
 * moved. Damaging one would therefore test that comparison rather than what
 * happens when a path is *used* — so both are set to the same untrusted value,
 * which is what a partial replay of damaged retained state actually looks like.
 */
export function damageCheckoutPath(path: string, name: string, replacement: string): void {
  changedExactlyOne(path, "UPDATE workspace_repositories SET checkout_path = ? WHERE name = ?", [
    replacement,
    name,
  ]);

  let rewritten = 0;
  tamper(path, (database) => {
    for (const row of database.prepare("SELECT sequence, record FROM journal_events").all()) {
      const parsed: unknown = JSON.parse(String(row["record"]));
      const description = Object(Reflect.get(Object(parsed), "description"));
      if (Reflect.get(description, "type") !== WORKSPACE_REPOSITORY) {
        continue;
      }
      const record = Object(
        Reflect.get(Object(Reflect.get(Object(parsed), "result")), "value"),
      ).record;
      if (Object(record).name !== name) {
        continue;
      }
      Object(record).checkoutPath = replacement;
      database
        .prepare("UPDATE journal_events SET record = ? WHERE sequence = ?")
        .run(JSON.stringify(parsed), row["sequence"]);
      rewritten += 1;
    }
  });
  if (rewritten !== 1) {
    throw new Error(`the journal holds ${rewritten} creation records for ${name}`);
  }
}

export function isStale(candidate: unknown): candidate is RepositoryStaleStateError {
  return candidate instanceof RepositoryStaleStateError;
}

/**
 * What one composition effect recorded, as the journal holds it.
 *
 * The status is the whole point of these claims. A refusal that the run reports
 * to the document and records as a success is a history that disagrees with
 * itself, and only the retained result says which one happened.
 */
export function* compositionResults(
  database: WorkflowRunDatabase,
): Operation<{ status: string; name: string; message: string }[]> {
  return (yield* compositionEvents(database)).map((event) => {
    const result = event.result;
    if (result.status === "err") {
      return {
        status: result.status,
        name: result.error.name ?? "",
        message: result.error.message,
      };
    }
    return { status: result.status, name: "", message: "" };
  });
}

/**
 * A host directory holding what `build` puts there, at the Workspace path a
 * substitution is aimed at.
 *
 * The staging half of every substitution suite: it produces a real tree on the
 * host, and the caller imports it over the retained one through the test-only
 * storage fixture.
 */
/** A host directory holding `tree`, ready to be imported over `workspacePath`. */
export function* substitute(
  host: { useDirectory(): Operation<string> },
  workspacePath: string,
  build: (target: string, home: string) => Operation<void>,
): Operation<string> {
  const root = yield* host.useDirectory();
  const target = `${root}${workspacePath}`;
  yield* until(mkdir(target.slice(0, target.lastIndexOf("/")), { recursive: true }));
  yield* build(target, root);
  return root;
}
