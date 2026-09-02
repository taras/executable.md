# Issue #643 — `<Dir>` production-correction handoff

## Continuity

- Stack base commits:
  1. `0b02832d136ab9f847cc7a97ef16ba333c013e3a`
  2. `7be4b873252e1d4c715e04bdacd03ab5b9ce2916`
  3. `e9ff9d60565c9f9986c5371cd3710d4fc122ccaa`
- This correction follows the architecture-artifact commit on top of PR 3.
- Existing PR #689 remains untouched. Pushes and PR editing belong to delivery,
  not this feedback step.
- Preserve `scratch/orc19-probe.ts`; do not create, remove, prune or repair a
  worktree.

## Settled correction

`<Dir path>` is not placement-only. It performs one provider-neutral semantic
directory operation before it installs cwd or expands content:

- recursively create the specified directory when it is missing;
- use an existing directory without replacing, clearing or otherwise changing
  it or its contents;
- refuse a target or intermediate entry that is a file or another
  non-directory, before content begins;
- resolve a relative path against the enclosing contextual cwd and preserve the
  component's existing absolute-path behavior;
- expand content with the resulting directory as cwd;
- restore the enclosing cwd on success, failure and cancellation;
- leave created directories in place, including after later content failure or
  cancellation; and
- change no Repository selection or identity member.

The contract applies to ordinary and workflow runs. Shared `<Dir>` calls only
the mandatory stable `API.Files.ensureDirectory` operation. It does not call
`API.Fs`, `@effectionx/fs`, a runtime API or RepositoryComposition. The absent
Files provider remains fail-closed, and independently loaded package copies
compose through the stable Api name. All four host entrypoints install the host
Files provider, so Node and Bun retain operational `<Dir>` behavior despite
having no ordinary repository provider.

## Provider contracts

The host Files provider resolves the target in the contextual filesystem,
recursively creates it directly, accepts an existing directory and maps every
documented refusal to the shared sanitized vocabulary. It is deliberately
non-transactional: successful creation persists, and neither later content
failure nor cancellation triggers rollback or teardown deletion.

The workflow Files provider publishes exactly one `workspace_file` effect for
the ensure. Recursive mutation runs inside its savepoint. On success, the
mutation, sanitized outcome and resulting Workspace root commit together. A
documented refusal rolls the savepoint back and records the refusal against the
unchanged root. Infrastructure failure or cancellation before commit publishes
neither an outcome nor a root. Completed replay restores the recorded success
and retained root without attempting creation again. No retained field contains
a host path, errno/platform code, raw platform message or cause.

## Generated-XMD authority

The product decision is settled: selecting `allow={["write"]}` intentionally
authorizes `<Dir>`'s persistent recursive directory creation.

Make that authority change visible in retained identity. The paired write-table
entry is `@executablemd/workflow/composition/dir-v2#Dir`. The former
`@executablemd/workflow/composition#Dir` identity authorized placement that
created nothing and must never authorize creation. A continuation retaining the
former identity refuses before generated execution and mutation. Read-only
admissions remain unaffected because they never selected the write table.

## Implementation boundaries

1. Extend the shared `API.Files` contract with mandatory
   `ensureDirectory(cwd, path)` returning Effection `Result<Unit>`. Keep the
   existing fail-closed terminal and stable namespaced Api.
2. Implement the operation in the host Files provider through asynchronous
   Effection filesystem operations. Preserve the host provider's containment
   and sanitization rules, including the established absolute-Dir exception.
3. Implement it in the transaction-bound workflow Files provider as one named
   `workspace_file` effect and savepoint, using the logical Workspace path and
   root-publication protocol already used by file mutations.
4. Change shared `<Dir>` ordering to ensure, then install cwd, then expand
   content. Scope teardown restores cwd only.
5. Version the pinned paired Dir origin in the generated write table and cover
   continuation refusal from the former identity.
6. Keep Repository composition out of the operation. Do not select, replace or
   reconstruct a Repository from a directory path.
7. Update the component description to the already accepted text, without
   further product interpretation:

   > Create or use a directory. `<Dir path={worktree}>…</Dir>` changes the working directory for its content.

Do not add a second directory API, a test-only provider fallback, host/runtime
detection in shared code, rollback for ordinary host creation or deletion during
Dir teardown.

## Frozen acceptance evidence

Evidence must distinguish every row; one broad happy-path test does not replace
the failure, replay or authority cases.

| ID | Criterion | Discriminating evidence |
| --- | --- | --- |
| ORC6 | Missing directory and ordering | Missing relative parents are created recursively, an absolute target keeps its meaning, and no content begins before the ensure succeeds |
| ORC6a | Existing directory | Existing contents remain byte-identical; the directory is neither replaced nor cleared |
| ORC6b | Non-directory refusal | File and supported special targets, including an intermediate entry, refuse before content with sanitized structural data |
| ORC6c | Cwd restoration | The enclosing cwd is restored after success, printed failure and cancellation |
| ORC6d | Repository invariance | Every Repository identity member and provider selection remains unchanged inside and after Dir |
| ORC6e | Ordinary persistence | Host-created directories remain after success, failed content and cancellation; no teardown delete runs |
| ORC6f | Workflow atomicity | Recursive creation, one `workspace_file` success and its resulting authoritative root commit together before content |
| ORC6g | Workflow refusal rollback | A documented non-directory refusal rolls back its savepoint, creates no partial parent, begins no content and records the unchanged root |
| ORC6h | Workflow replay/cancellation | Completed replay performs no second ensure and restores the retained root; pre-commit cancellation publishes nothing; later content cancellation preserves the committed directory |
| ORC6i | Generated authority | `write` admits only paired `dir-v2#Dir`; the former retained identity refuses before generated execution and creates nothing |
| ORC20 | Retained regression | Repository/Worktree/Git/Issue/PullRequest replay contracts and provider call counts remain unchanged; directory ensure contributes only its own effect/root |

Also extend the shared host Files contract/compiled probe and the absent-provider
suite. Exercise the ordinary component under Deno, Node and Bun because the
host Files provider is their operational boundary. Exercise workflow creation,
existing-directory adoption, refusal rollback, completed replay, current-root
publication and cancellation at the retained provider boundary.

## Feedback handoff

Create one production feedback commit on top of the architecture-artifact
commit after the smallest focused tests that discriminate these rows pass. Hand
back its exact base and SHA, every changed file, every focused command and exact
result, the row-to-test mapping, and any deviation. Do not wait for CI or push
before requesting the architecture verdict.
