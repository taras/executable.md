# Specification: Workflow runs

* **Status:** Current
* **Scope:** `@executablemd/workflow` — associating a document execution with a
  workflow run whose starting repository state is pinned once.

---

## 1. Overview

A **workflow run** is a workflow being carried out, with its progress and
outcome recorded durably. Document executions perform its work; the run itself
outlives any one of them.

A run has one starting repository state, chosen once. The host supplies a
**base** — any Git revision expression — and the run resolves it to a **pinned
commit** the first time it is created. A branch that moves afterwards does not
change what the run started from.

```ts
import { execute } from "@executablemd/core";
import { useWorkflow, getWorkflowRun } from "@executablemd/workflow";

yield* useWorkflow({ base: "main" });
const execution = yield* execute({ path: "./workflow.md", stream });
```

The package owns `WorkflowRun`, `useWorkflow()`, `getWorkflowRun()` and the Git
capability. It depends on `@executablemd/core`,
`@executablemd/durable-streams` and `@executablemd/runtime`, whose contextual
`exec()` and `cwd()` the Git provider invokes. Core never imports workflow or
Git, so ordinary `execute()` and `xmd run` stay Git-independent.

## 2. What a run is

```ts
interface WorkflowRun {
  readonly runId: string;
  readonly base: string;
  readonly pinnedCommit: string;
}
```

`runId` is opaque, allocated with cryptographic randomness, and supports
equality only. `base` is the revision expression the host supplied.
`pinnedCommit` is the full object id that base resolved to.

`getWorkflowRun()` answers with the frozen value for the document execution
running now. Every call in one live execution answers with the same object; a
replay preserves the field values, never JavaScript object identity. It throws
outside a document execution associated with a run, and exposes no journal, Git,
workspace or continuation capability.

## 3. Where the run is installed

`useWorkflow({ base })` installs ordinary middleware in the scope that owns one
document execution, and does nothing else. **Installing it creates no workflow
run**; executing a document under it does.

The value is installed in the scope that owns the document execution, so every
descendant of the expansion reads it, output emitted after the durable run still
sees it, and ordinary teardown takes it away. It is not readable before
`execute()` and not readable after that execution completes, even while the
installing scope is still alive.

Concurrent runs are isolated by scope ownership: each document execution and its
middleware installation share one child scope. A later document execution —
including one continuing the same workflow run — gets a new child scope and a
new installation.

## 4. The three journal states

The journal decides which middleware does the work.

| State | What runs | What happens |
| --- | --- | --- |
| **live** — no record | `Execution.document` | allocates the run id, resolves the base through `Git.revParse()`, records one immutable value, and only then imports the root |
| **truncated** — record present, root not closed | the replay guard, then `Execution.document` | the guard restores the value; the durable operation still runs, so the journal cursor advances past its own entry |
| **completed** — root `Close` recorded | the replay guard only | the durable run returns the stored result without invoking the workflow, so the guard's check phase is the only place the run can be restored — or a different base refused |

The check phase runs before the recorded root result is returned. That ordering
is what lets a completed journal refuse a supplied base that disagrees with the
recorded one, rather than handing back a result the caller did not ask for.

Replay invokes neither run-id allocation nor `Git.revParse()`. The current value
of a moving branch is never consulted.

## 5. Refusals

The journal is parsed, never trusted.

- A record that does not describe a workflow run is refused. The stored value is
  described, never quoted: it is external data, and reporting it would carry
  whatever it held into logs and rendered output.
- A recorded base that differs from the supplied base is refused, naming both.

Both are `StaleInputError`: the journal no longer describes this run, and the
document is re-run from the start rather than resumed.

## 6. When a run exists

A workflow run exists once its `WorkflowRun` value is durably recorded. A
document failure or cancellation after that point does not erase it.

Failure *before* that point creates no run and expands no root document: Git
cannot be invoked, the working directory is not a Git repository, or the base
does not resolve to a commit.

Such a failure is journaled the way every durable effect's failure is — as a
recorded failed effect. Resuming the same journal therefore reproduces the
failure rather than retrying Git. No `WorkflowRun` value exists in either case,
which is what "records no workflow run" means.

## 7. The Git capability

```ts
interface GitApi {
  revParse(revision: string): Operation<string>;
}
```

`Git.revParse(revision)` has the semantics of

```sh
git rev-parse --verify --end-of-options <revision>
```

in the contextual working directory. `--verify` makes an unresolvable revision
an error rather than an echo; `--end-of-options` stops a revision that looks
like a flag from being read as one. The command is an array, so nothing is
parsed by a shell.

The default provider invokes the Git CLI through the contextual process and
working-directory Apis. A non-zero exit fails, reporting what Git said; a clean
exit naming nothing fails too, because an empty object id would pin a run to no
repository state at all.

Another provider replaces it lexically with
`Git.around({ *revParse(…) {…} }, { at: "min" })`. Providers install at `min` so
a nested replacement wins rather than being shadowed by an outer handler.

Workflow initialization calls it with `${base}^{commit}`, which is what makes
"does not resolve to a commit" an error rather than a tag object id.

## 8. Expansion identity is separate

A durable workflow effect that needs workflow-wide identity uses the run id and
the expansion id (§5.6 of the Executable MDX specification) together. Two
workflow runs may contain the same expansion id; the expansion id does not embed
the run id, and expansion identity works with no workflow middleware installed
at all.

## 9. Intentionally excluded

Durable workflow lookup, artifact history and cross-process continuation;
`xmd workflow run` and `xmd workflow continue`; workflow-owned worktrees; and
deterministic Git and GitHub effects.
