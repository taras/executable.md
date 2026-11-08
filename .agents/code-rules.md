# Code rules

This rulebook records the code patterns all repository source follows — packages, scripts, site and tests alike.
AGENTS.md owns process boundaries and links here; architecture-rules.md
governs how new architecture is designed. Read this before writing or
changing code in any role. Numbering is stable; cite rules by number.

1. Use Effection `function*` generators with `yield*`; no Promises, async or
   await.
2. Use `@effectionx/fs`, never `node:fs` directly and never synchronously;
   where `@effectionx/fs` lacks an equivalent, adapt the runtime's async
   primitive as an operation. A synchronous site is allowed only to keep a
   named correctness invariant, carrying one `oxlint-disable-next-line local/no-sync-filesystem` and a comment naming that invariant; there
   is no file-wide or directory-wide exemption. Enforced:
   `local/no-sync-filesystem`.
3. Convert a promise to an operation with `until`, not `call`.
4. Comment only surprising behavior; never what code does.
5. Describe implemented behavior in the present tense; no roadmap language in
   specs or source.
6. Parse to infer types; do not cast with `as`.
7. No braceless `if` statements.
8. Changes to release configuration require matching changes to
   [specs/release-process-spec.md](../specs/release-process-spec.md).
9. Prefer stateless generators: use a plain function when it only returns
   another operation.
10. Structure source through names and modules; no section-divider comments.
    Enforced: `local/no-section-divider-comments` (autofixes).
11. Prefer expanding Executable.md capabilities over JavaScript in documents;
    do not add JavaScript to an MD document without verifying with the user or
    planner. Authoring style: [.agents/executable-style.md](executable-style.md).
12. Use contextual APIs for environment-specific behavior; shared production
    modules neither access host APIs nor detect the runtime. Runtime-named entrypoints and adapters install host behavior — `packages/cli/src/{deno,node,bun,compiled}.ts` are the CLI's; `packages/test-support` is
    the tests' exempt boundary (#156).
13. Hand outcomes back as Effection `Result`; no local ok-union types — put the success payload under `value` and the failure data on an `Error` — and return a narrowed failure rather than rebuilding it. Enforced:
    `local/prefer-effection-result` (autofixes the rebuild).
14. Keep `main` green — a process rule; its statement lives in AGENTS.md
    (Verification), kept under this number so citations stay stable.
15. State shared across loaded copies uses stable, namespaced names. Choose
    owned handles for instance operations, Context for scoped service
    selection, and contextual Api middleware for per-call composition.
    Security enforcement, durable identity and reconciliation never trust
    replaceable context state.
16. An event listener installed by an operation has that operation's lifetime:
    wait for one event with `once()` from `@effectionx/node/events`, and a longer subscription binds a stable handler and removes that same handler
    in the owner's teardown — `.off()` for Node, `.removeEventListener()` with
    the matching capture mode for the DOM — with the cleanup established
    synchronously **before** the subscription: an `ensure()` yielded after the
    subscription has established nothing. Where teardown must wait on the event
    itself, keep the handler through the wait and remove it in a synchronous
    `finally` inside that same `ensure()`. A native resource is never created
    before the cleanup that releases it, and only the resource's own closing
    event proves it is finished, never an assigned exit status. Each
    owner's child-reaping is held by a focused lifecycle regression. Full
    lifecycle rules:
    [architecture.md](../architecture.md#scopes-and-settlement). Enforced:
    `local/require-scope-bound-event-registration` (no autofix).
