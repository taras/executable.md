---
props:
  package:
    type: string
    pattern: "^packages/[a-z0-9][a-z0-9._-]*$"
    description: Workspace package to reserve on npm, e.g. packages/workflow
---

# executable.md

This is the development guide for the executable.md repository. It covers
preparing a checkout, building the `xmd` binary, and running the verification a
change owes before it is offered for review.

Three documents own the rest:

- [`AGENTS.md`](AGENTS.md) — the contribution, review and verification rules:
  which evidence a change needs, when a feedback commit is given, and what the
  delivery gate is.
- [`architecture.md`](architecture.md) — the invariants any implementation of
  the engine satisfies.
- [`specs/executable-mdx-spec.md`](specs/executable-mdx-spec.md) — what the
  product does, with the conformance matrix that pins it.

Locate the package that owns the behavior you are about to change:

- `packages/core/` — the engine: the boundary scanner, component expansion,
  `exec` and `eval`, modifiers, and the `execute()` entry point.
- `packages/cli/` — the `xmd` command. `src/cli.ts` is runtime-neutral;
  `src/{deno,node,bun,compiled}.ts` install the host adapters each runtime needs.
- `packages/runtime/` — the contextual host APIs — process, filesystem, env,
  config — that every other package reaches the host through.
- `packages/durable-streams/` — the journal protocol, replay and divergence.
- `packages/workflow/` — workflow runs, run storage, and the Workspace.
- `packages/testing/` and `packages/test-agent/` — `<Test>` and the
  deterministic agent; `packages/test-support/` is the one BDD surface all three
  runtimes share.
- `packages/acp/`, `packages/web/`, `packages/code-review-agent/` — the coding
  agent bridge, the web form host, and the review agent.
- `scripts/` — this repository's own tooling: setup, builds, release targets,
  and the checks CI runs.
- `specs/` — the specification each package is held to.

On a fresh clone, start here:

```bash exec
deno task setup
```

Success provides the prepared checkout every command in this guide reads from,
including the source CLI the targets below run through.

With that in place, this guide is itself an executable document: each section is
a target you can select, and selecting one runs the commands it describes. Ask
the document what it offers:

```bash
deno task xmd run README.md --help
```

It answers with the properties this document declares and every target you can
invoke, each named by the reference that selects it and described by what
selecting it does.

Preparation is common to all of them, so the block above is the document's own
preamble: whichever target you select runs it first, and the checkout is
prepared again before the work you asked for.

Each command's output reaches you as it is produced, the way it does when you
type the command yourself. A command that exits nonzero ends the run there, with
that command's diagnostic on stderr and a nonzero exit status.

Every task these sections compose stays directly callable:

```bash
deno task setup     # install both dependency layouts, build the browser bundle
deno task build     # compile the standalone xmd binary
deno task lint      # oxlint + oxfmt
deno task check     # typecheck
deno task check:jsr # JSR publishability dry run
deno task test      # the full Deno suite
deno task verify    # the whole applicable battery, concurrently
```

## Setup

Prepare both dependency layouts and the browser bundle, yielding a checkout
ready for every build and verification command in this guide.

```bash
deno task xmd run README.md#Setup
```

Select it after changing a dependency, or whenever you want the checkout
restored on its own without building or testing. It executes `deno task setup`,
the preamble block above and the only thing in this repository that installs.
Setup owns both dependency layouts — `node_modules/` and Deno's global cache —
and prepares them in the order their union resolves in: Deno's frozen install
and cached module graphs first, then pnpm's store beside it, then the browser
bundle.

The prepared layouts resolve for Deno, `tsc`, Bun, oxlint and the site. Builds
and checks read what setup prepared and leave tracked files, `node_modules` and
`deno.lock` as they found them, so they compose with one another.

## Build

Compile the standalone `xmd` binary: prepare the checkout and then build,
yielding `dist/xmd`, a self-contained executable for this host.

```bash
deno task xmd run README.md#Build
```

The build produces the browser bundle the binary embeds and compiles the CLI.

```bash exec
deno task build
```

Run `dist/xmd` directly once it reports success.

## Test

Run Focused and then Complete, yielding implementation-feedback evidence and
delivery verification from one invocation.

```bash
deno task xmd run README.md#Test
```

Testing comes in two levels, and this heading is the parent of both: Focused is
the evidence a change offers for review, and Complete is the battery that
decides whether it merges.

### Focused

Run the lint and format check, the typecheck, the JSR publishability dry run,
and the tests this branch and worktree affect, yielding the evidence a feedback
commit is offered with.

That is enough to show the change is sound, in the time a feedback loop can
afford. Each check is its own block, so the first command to fail is where the
run stops and what it stopped on is unambiguous.

```bash
deno task verify:focused
```

That task is this repository's entry point and enters this target directly.

```bash exec
deno task lint
```

```bash exec
deno task check
```

```bash exec
deno task check:jsr
```

```bash exec
deno task test --changed=origin/main
```

Success means all four reported clean: zero lint and format errors, no type
errors, `Success Dry run complete` from the dry run, and every affected test
passing. That is the state a feedback commit is offered from; `AGENTS.md`
describes what happens next.

### Complete

Run the complete applicable battery concurrently, yielding delivery
verification and proof that the worktree it ran in is unchanged.

```bash
deno task xmd run README.md#Test/Complete
```

It runs `deno task verify`, the same checks CI requires: every applicable
command starts at once, they are reported in a fixed order however they finish,
and the first failure's output is printed in full.

```bash timeout=30m exec
deno task verify
```

`verify` compares tracked files afterwards and fails if any command moved one,
so a green result is also evidence that the battery left the repository exactly
as it found it.

## Bootstrap

Validate and reserve a new workspace package name on npm, yielding the empty
package a later tagged release publishes to.

Adding a package to `packages/*` needs this one manual step before CI can
release it: a tagged release publishes with OIDC, and OIDC can only publish a
package that already exists, so the name is reserved by hand, once, per
package.

```bash
npm login
deno task xmd run README.md#Bootstrap --props-package packages/<name>
```

<If condition={props.package !== undefined}><BootstrapNpmPackage package={props.package} /></If>

<If condition={props.package === undefined}>

No package was named, so nothing was reserved. Name one with `--props-package`
to run the reservation; it explains each step as it takes it, previews the
placeholder before publishing anything, and refuses rather than touch a package
that already carries versions.
[`specs/release-process-spec.md`](specs/release-process-spec.md) §6 carries the
whole procedure, including the JSR half.

</If>
