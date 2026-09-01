# Specification: Release process

* **Status:** Current
* **Scope:** How a version of executable.md ships: tagging, binary release, and
  npm/JSR package publishing.

---

## 1. Overview

Every merge to `main` updates a rolling draft release whose notes list the
PRs merged since the last published release. A release is triggered by a
maintainer publishing that draft via the GitHub Releases UI, which creates a
`vX.Y.Z` tag from `main`. No workflow creates tags.

The tag starts two workflows: `release.yml` compiles the `xmd` binaries, attests
each one, and attaches them to the release; `publish-packages.yml` publishes
every `@executablemd/*` package to npm (primary) and JSR (secondary). npm publishes
per package; JSR publishes all workspace packages together. Binaries come
first: `publish-packages.yml` publishes nothing until `release.yml` succeeds,
so npm versions never exist without matching binaries. Both workflows build
from the tag's commit.

```mermaid
sequenceDiagram
    actor M as Maintainer
    participant DR as draft-release.yml
    participant GH as GitHub
    participant R as release.yml
    participant PP as publish-packages.yml
    participant PO as publish-one.yml (per package)
    participant NPM as npm
    participant JSR as JSR

    GH->>DR: push: main (PR merged)
    DR->>GH: update draft release changelog
    M->>GH: publish the draft → tag vX.Y.Z from main
    GH->>R: push: tags v*
    GH->>PP: push: tags v*
    R->>R: validate tag matches packages/cli/deno.json
    R->>GH: compile and attest xmd per target,<br/>attach binaries + checksums to the release
    PP->>PP: validate tag matches every manifest,<br/>wait for release.yml to succeed
    PP->>PO: one call per package,<br/>needs-ordered (deps first)
    M-->>PO: approve npm-publish environment
    PO->>NPM: npm publish --access public (OIDC,<br/>skipped if version already published)
    PP->>JSR: deno publish (whole workspace,<br/>already-published members skipped)
```

## 2. Version lockstep

Every publishable package (`packages/core`, `packages/cli`,
`packages/durable-streams`, `packages/runtime`, `packages/testing`,
`packages/code-review-agent`, `packages/test-agent`, `packages/acp`,
`packages/web`, `packages/workflow`) declares the same version in its `deno.json` and
`package.json`. A member marked `"private": true` is outside the lockstep
because it never publishes — `packages/test-support` is the one, and it stays
at `0.0.0`. `packages/cli/src/cli.ts`
imports `packages/cli/deno.json` and reads `version`
from it, so the compiled binary reports the manifest version — the manifests
are the single source. The npm version derives from the tag, and both
workflows refuse a tag the manifests do not declare, so the two cannot
diverge.

To cut a release: run `deno task bump <version>` (stamps every manifest),
restamp the workspace versions in `bun.lock`, merge to `main`, then publish the
draft release — its tag follows the manifests (§3).

`bun.lock` records a `version` for every workspace member, and the bump task
does not touch it — `bun install` will not restamp those entries either, since
they already satisfy the lockfile. Left alone they keep the previous release's
number. Only the members whose `name` is an `@executablemd` package change; an
unrelated dependency that happens to share the old version number must not.

The bump touches nothing else. PR Review and Repo Analysis prepare and build
the checked-out revision with `deno task setup` and `deno task build`, then run
`./dist/xmd`. They do not
install the latest published release, so a review always understands the
documents at the revision it checks.

## 3. Workflows

- **`draft-release.yml`** (`push: main`): maintains the rolling draft release
  with release-drafter (config: `.github/release-drafter.yml`). Each merged PR
  appends a changelog line; publishing the draft cuts the release. After every
  merge the workflow syncs the draft with the manifests: when the manifest
  version is already released, the draft's notes carry a warning banner saying
  the manifests need bumping; once bumped, the banner clears and the draft's
  tag and title default to the guard-passing `v<version>`.
- **`release.yml`** (`push: tags v*`): a preflight job validates the tag
  against `packages/cli/deno.json`; on mismatch it flags the just-published release on
  the Releases page — caution note in the notes, a failed title, and the
  prerelease marker — so a forgotten bump is visible where the release was
  made, then refuses to build. On a valid tag it compiles
  `packages/cli/src/compiled.ts` per target with
  `--include packages/code-review-agent --include packages/cli/src/documents`
  and attaches the binaries and
  sha256 checksums to the tag's GitHub Release. That module is the
  compiled-binary entrypoint: it installs the `API.Env.command` adapter that
  relaunches the binary as itself, which a source entrypoint cannot do. Between
  that compile and the upload, each matrix job attests its
  `dist/${{ matrix.artifact }}` with a commit-pinned `actions/attest`, so GitHub
  publishes build provenance for the exact bytes the job produced — one attested
  subject per target, from one shared step. The `release` job needs the whole
  `build` matrix, so a failed attestation withholds every binary instead of
  releasing an unattested one.
- **`review.yml`** and **`repo-analysis.yml`**: install the repository-pinned
  Deno and pnpm actions, run `deno task setup` and `deno task build`, and
  execute the checked-out `./dist/xmd` against the checked-out Markdown. Their CI roots use `<Output>`
  error mode, so execution failures fail the workflow through the CLI exit
  status. Journals and reports are uploaded with `if: always()`; Actions does
  not interpret journal records or rendered error markers.
- **`publish-packages.yml`** (`push: tags v*`): GENERATED by
  `scripts/gen-publish-workflow.md` — an executable markdown document that
  expands the root `workspace` entries (including one-level globs such as
  `packages/*`) and derives the jobs from the member manifests it finds, a
  member without a `deno.json` naming an `@executablemd` package being skipped
  — never edited by hand. A member whose `package.json` declares
  `"private": true` is also skipped and appears in no npm job, so a package can
  land its foundation on `main` before it is ready to publish; clearing the flag
  adds it back on the next regeneration. Such a member also declares no
  `deno.json` `name` and no `exports`, so `deno install` warns about neither an
  unpublishable name nor a missing `exports`, and `deno publish` finds no JSR
  entry to publish either; both fields land in the same PR that clears the
  private flag. The two conditions are independent rules, and no repository
  member reaches the second one on its own, so
  `scripts/tests/publish-workflow-generator.test.ts` runs the generator over a
  fixture member that holds a full JSR identity and declares `"private": true`.
  Run
  `deno task gen:publish-workflow` after adding/removing a
  workspace package or changing its `@executablemd` dependencies; CI fails if
  the committed file is stale. Its `version` job validates the tag against
  every manifest and polls the `release.yml` run for the same commit, failing
  if the binary build fails. It then fans out one `publish-one.yml` call per
  package, ordered with `needs:` so dependencies publish before dependents
  (leaves run in parallel), plus one `jsr` job for the whole workspace.
- **`publish-one.yml`** (`workflow_call`, inputs `package`/`version`): builds
  one package with dnt (`scripts/build-npm.ts`) and publishes it to npm. Runs in
  the `npm-publish` environment. npm publishing is idempotent: it skips an
  already-published version. Library entry points come from the member's
  `deno.json` `exports`; an executable comes from its `package.json` `bin`, so
  the npm CLI ships `packages/cli/src/node.ts` while JSR gets the Deno
  entrypoint.

No published package may depend on a `jsr:` specifier. dnt rewrites one into a
`@jsr/*` npm dependency, which the default registry does not serve, so every
consumer would need a `@jsr:registry` mapping in their own npm configuration —
something a package cannot ship, because npm strips `.npmrc` from published
tarballs. Verify it on the emitted manifest: after a `scripts/build-npm.ts` run,
`packages/<name>/npm/package.json` declares no `@jsr/*` dependency.

### Local builds

A normal build installs the package's dependencies from npm and resolves its
siblings to their published versions. That is the path `publish-one.yml` runs.

`DNT_SKIP_INSTALL=1` skips that install and the type check, for exercising the
tooling before a version reaches npm. It covers only packages that declare no
`workspace:*` dependencies. dnt emits through TypeScript, which resolves from
the output directory, so the install is what supplies a sibling's declarations;
without it a sibling resolves to its workspace source and lands in the package.
The builder therefore refuses a package that declares one, naming the
dependencies and leaving the output directory empty. Release workflows never set
the variable.

`DNT_LOCAL_SIBLINGS=1` builds each internal sibling first — depth-first over the
`workspace:*` dependencies, once per package — and depends on those artifacts by
absolute path (`file:<package-dir>/npm`) instead of by published version. The
build therefore type-checks against the sources in the working tree, which is
what a branch changing a shared API needs and what the `packages/cli` npm suite
runs. The emitted package.json names local directories, so an artifact built this
way is a verification artifact, never a publishable one. Release workflows never
set the variable.

### JSR publishing

`deno publish` runs once from the repo root and publishes every workspace member
together. Members reference each other by bare name (`@executablemd/core`) with
no import-map entry: Deno resolves those through workspace membership, and
`deno publish` records them as `jsr:` dependencies. A member manifest must not
map a sibling to a relative path — a path that leaves the package root resolves
against the publish root and the module graph fails to build.

A JSR failure fails the release. The job needs no idempotency guard of its own:
the pinned Deno v2.9.1 queries the registry and skips each workspace member JSR
already carries at that version, member by member. A rerun after a partial publish
therefore completes exactly the members that are missing, and a rerun after a
complete publish exits 0 without republishing. Never gate the job on one
package's existence — whether `core` is published says nothing about the other
six.

`deno task check:jsr` runs the same command with `--dry-run` and is a required
CI job on every PR (§3, `ci.yml`). It enforces JSR's fast-check rules, so every
symbol in a package's public API needs an explicit type annotation and no export
may be a destructuring. It does not exercise the publish-time module-graph
rewrite, which only a real publish reaches.

## 4. npm authentication (OIDC, no token)

`publish-one.yml` authenticates to npm with GitHub Actions OIDC trusted
publishing; the repo holds no npm token. Each package's trusted publisher on
npmjs.com (Settings → Trusted Publisher → GitHub Actions):

| Field                | Value                  |
| -------------------- | ---------------------- |
| Organization or user | `taras`                |
| Repository           | `executable.md`        |
| Workflow filename    | `publish-packages.yml` |
| Environment name     | `npm-publish`          |
| Allowed actions      | `npm publish`          |

npm validates the **calling** workflow's filename for `workflow_call`, not the
reusable `publish-one.yml`. Binding the environment name makes npm reject OIDC
tokens minted outside the gated environment.

That same trusted publisher is what makes the packages carry provenance: npm
generates it automatically for a public package published from a public
repository over OIDC, which is exactly this path. `npm publish --provenance` is
therefore intentionally absent — the flag would add nothing the identity npm
already validated does not supply.

The binaries carry provenance of their own (§3), attached to GitHub rather than
to a registry. A consumer verifies a downloaded one against this repository:

```sh
gh attestation verify ./xmd-<target> -R taras/executable.md
```

## 5. Protection configuration

- The **`npm-publish` environment** requires reviewer approval and deploys
  only for `v*` tags, and every npm trusted publisher is bound to it (§4). The
  `jsr` job runs in it too, so both registries admit the same publishers.
- **Rulesets** require PRs into `main` and restrict `v*` tag creation to
  maintainers.

## 6. Adding a new package

A tagged release cannot publish a package that does not yet exist on npm and
carry a trusted publisher, and npm documents those two in that order: "the
package you're configuring must already exist on the npm registry"
(`npm help trust`, npm 11.17). The workflows carry no npm token, so the first
record is made by hand, once.

That documented order is the supported one, and this procedure follows it. It is
not a claim about what the registry will refuse: #276 records `npm trust github`
succeeding for `@executablemd/web` while the registry still answered 404 for the
package itself. What that configuration then did through a real first tagged
publish was never established, so nothing here relies on it.

`components/BootstrapNpmPackage.md` is that procedure. It publishes an empty
`0.0.0-bootstrap.0` reservation under the `bootstrap` dist-tag, then configures
GitHub Actions as the package's trusted publisher with the values in §4's table.
It never publishes `latest` — the first tagged release does that.

The reservation is empty because the real artifact cannot be the record that
makes publishing possible. A package declaring `workspace:*` dependencies
resolves its siblings from the registry at build time, so its first artifact
cannot be built until those siblings are published — and they cannot be
published to a package that does not exist. An artifact with no dependencies at
all has no such cycle, which is what lets a package declaring siblings —
`@executablemd/acp` and `@executablemd/test-agent` among them — be bootstrapped
at all.

`0.0.0-bootstrap.0` is never a release version, so `publish-one.yml`'s
already-published guard never matches it: the first tagged release publishes its
own version normally and npm points `latest` at it. The `bootstrap` dist-tag
stays where it is.

1. Create its directory under `packages/` with a `deno.json` (name under
   `@executablemd`) and a `package.json` declaring its dependencies
   (`workspace:*` for internal siblings). The root `deno.json` covers it through
   the `packages/*` workspace glob, so membership needs no edit. Run
   `deno task gen:publish-workflow` and commit the regenerated orchestrator.
2. Reserve the name and install the trusted publisher, as an `@executablemd`
   scope owner on npm 11.15 or newer:
   ```sh
   npm login
   deno task xmd run README.md#Bootstrap --props-package packages/<name>
   ```
   `README.md#Bootstrap` is the entry point; it invokes
   `components/BootstrapNpmPackage.md`, which is also runnable directly. Naming no
   package reserves nothing, so the target composes into a whole-README run
   without reaching the registry.
   Run it **without `--journal` and without `--verbose`**. The document elicits
   a one-time code and interpolates it into the publish and trust commands; a
   journal file records both the answer itself and those commands, and
   `--verbose` reports the same records to stderr. Rendered output carries only
   what a command printed, so neither flag is needed and both would persist the
   code.
3. Create the package on jsr.io under the `@executablemd` scope and link it to
   this repository, **before** the first tagged release that includes it.
   `deno publish` fails for a package that does not exist on JSR, and the JSR
   job publishes the workspace as a unit — so one uncreated package fails the
   release for every package.

### What the document checks, and re-running it

The document verifies before it works, and renders what it verified:

- the operator is logged in, from `npm whoami`;
- npm is 11.15 or newer, from `npm --version`;
- `{props.package}` is a workspace member whose `package.json` and `deno.json`
  both exist and agree on an `@executablemd` name.

npm supplies those values and the document compares them, so a failure stops the
run before the registry is inspected, before the artifact exists, and before a
one-time code is requested.

The reservation artifact is written as Markdown rather than assembled by a
shell: `<File>` writes the `package.json` and `README.md` into a temporary
working directory, and `npm pack --dry-run` previews that exact directory before
anything is published from it. Every registry command — both reads and both
writes — is an `exec as="…"` block, so what it settled to, exit code and both
channels, is bound as a value: npm reports a package it does not carry by
exiting non-zero, and here that is an answer rather than a failure. The
comparison happens in the document and `<If>` selects what happens next, so what
the document decided is readable in what it rendered. That covers a refused
write as much as a 404: a publish npm rejects is reported in npm's own words,
where `silent` would have hidden both channels and left an exit code with the
reason discarded.

No read decides whether to publish. A read is a claim about a moment that has
passed, and npm accepts a write before its package reads report it — so a
reservation a read finds missing may have been made since, and one it makes may
not be visible yet. Both failure modes were observed bootstrapping
`@executablemd/workflow`: a completed run reported as failed because the read
back still answered 404, and the re-run that followed planning a publish for a
version that already existed. The placeholder is therefore always offered, and
npm's answer settles it. npm 11.17 asks the registry for the package's versions
with `preferOnline` before uploading anything and refuses over one it already
carries with an uncoded error carrying `You cannot publish over the previously
published versions: <version>` (`lib/commands/publish.js`); a registry that
answered that check staler than itself refuses the upload instead, as
`EPUBLISHCONFLICT`. Either is the answer "already reserved", from the party that
decides it. Any other refusal is a failure and is reported as one.

The reads that remain are guards, not decisions. A package carrying real
versions is not one to offer a placeholder to — a mistyped `--props-package` is
how that happens — so the versions and dist-tags are read before the code is
requested and again after it, and either read refuses. Neither selects what
happens next.

The one-time password is requested after the preview succeeds and before the
trusted publisher is read. `npm trust list` needs a code to answer at all: npm
makes a package's trusted publisher readable only to someone who could change
it, so what a package already trusts cannot be established without one. Every
run that gets past the version reads is therefore asked for a code — including a
re-run against a package that is already reserved and already trusted, which
reads, reports the end state, and writes nothing. The artifact is built on every run, because
every run offers it — the preview shows what will actually be attempted.

Nothing reads the package back to confirm it. Each write already answered, and
that answer came from the party that decides it, so a package read could only
disagree with what just happened. What is read back is the trusted publisher,
which npm serves from an authenticated path rather than the packument cache and
which answered truthfully while the package reads were still behind — it carries
the id that revokes the configuration, which the document prints.

Re-running is safe, and the two halves are skipped independently:

- a package already at `0.0.0-bootstrap.0` is offered the placeholder again and
  npm refuses it, which is how the run learns the reservation stands;
- a trusted publisher already matching §4's table exactly — GitHub Actions,
  `taras/executable.md`, `publish-packages.yml`, `npm-publish`, and publish as
  its only permission — is not created again.

Neither half is repaired. The registry "only supports one configuration per
package… If you attempt to create a new trust relationship when one already
exists, it will result in an error" (`npm help trust`, npm 11.17), so a
configuration that differs from §4's table stops the document, which reports
what it found and revokes nothing; replacing one is a deliberate
`npm trust revoke` by a scope owner, and the document prints that command with
the trust id it read. A version other than `0.0.0-bootstrap.0`, or a `bootstrap`
dist-tag pointing elsewhere, stops it the same way.

The version refusal happens before the code is requested; the trust refusal
happens after it, because the answer it turns on cannot be read without one.
Neither writes: the trusted publisher is read before the placeholder is
published, so a refusal leaves the registry exactly as it was. The versions are
read a second time after the prompt, because the operator is away generating a
code while they can change. The trusted publisher is not — its one read already
happened after the code, with only this document's own placeholder written
since, so a second read would have no away-time to cover. A publisher configured
in that gap makes `npm trust github` fail, which the run reports rather than
replaces.

## 7. Recovery

Re-run failed jobs on the tag's own workflow run. Publishing skips an
already-published version, so re-runs and re-tags of hand-bootstrapped
versions succeed. This holds per package on both registries: npm's guard runs
per `publish-one.yml` call, and `deno publish` filters already-published
workspace members individually — so a rerun after a partial publish picks up
only what is missing. No dispatch path publishes outside a tag.

A rerun of a `build` job compiles and attests again, and the release cannot
publish until that attestation succeeds. The guarantee is that the released
digest carries valid provenance from this repository, not that it was attested
exactly once — GitHub accepts more than one attestation for a subject, and
verification is satisfied by any valid one.

## 8. Browser assets (`@executablemd/web`)

`packages/web`'s browser client (`packages/web/client/**`) bundles through
`scripts/build-web-client.ts` (`deno task build:web`) into
`packages/web/generated/client-bundle.ts` — gitignored, never committed. The
Deno test suite (`scripts/tests/build-web-client.test.ts`) bundles and
inspects the real output, asserting determinism, absence of eval and
external-asset paths under the fixed CSP policy, that a build leaves the
installed dependency tree and its manifests exactly as it found them, and that
the build script writes its module wherever `--out` names. The suite writes to
scratch paths of its own rather than to the generated path: that path is read by
whatever else is running while the suite runs (AGENTS.md), and a test that took
a turn at writing it would be a race rather than a check.

The generated module is published through `replaceThroughStaging()` — staged
beside the target under a name carrying a UUID, then renamed over it. Deno, Node
and Bun resolve through that path while a build republishes it, and a direct
write exposes a truncated file for as long as the write takes. A reader
therefore sees the complete old module or the complete new one, never absence or
partial text; the staged file belongs to the invocation on every exit path, so a
halted or failed build leaves nothing beside the module. `deno task verify`
proves this with live readers rather than by inspection.

A build installs nothing: `deno task build:web` runs under node-modules and
cache modes that cannot create, relink, or fetch, and refuses on an unprepared
worktree (`scripts/preflight.ts`). `release.yml` compiles the binaries with
`deno compile` directly rather than through `deno task build`, so that
invocation carries the same `--node-modules-dir=none --cached-only --frozen`;
`scripts/tests/publish-workflow-membership.test.ts` asserts it for every
workflow that compiles.

Preparation comes in two kinds, and only one of them is anybody's routine.
**Host preparation** — `deno task deps`, and `deno task setup` around it — caches
what the machine it runs on needs, and is what a developer and every ordinary CI
job runs. **Target preparation** — `deno task deps:target <target>` — caches the
*selected target's* dependency graph, whether or not that target happens to match
the runner's own platform, and exists solely for a release job and for
`verify:clean`'s representative target. A local setup never performs it, so it
never downloads five platforms' packages.

`--cached-only` holds across the matrix because each job prepares its own
target. `deno compile --target` resolves the npm packages of the platform it
compiles *for*, which host preparation never cached — measured, a
`x86_64-unknown-linux-gnu` compile on a host-prepared tree fails on
`@msgpackr-extract/msgpackr-extract-linux-x64`. So every matrix job runs
`deno task deps:target ${{ matrix.target }}` between the bundle build and the
compile. That step is `deno install --entrypoint --node-modules-dir=none
--frozen` with the target's OS and architecture: it populates the job's Deno
cache and neither replaces nor relinks `node_modules`. The target-to-platform
mapping is contractual and lives in `scripts/lib/release-targets.ts`;
`scripts/tests/release-targets.test.ts` holds it to the workflow matrix by exact
set equality, checks the preparation argv per target, requires preparation to
precede compilation inside the build job, and requires the compile to keep
`--target`, `--cached-only`, and `--frozen`.

`deno task verify:clean` exercises that same sequence against a prepared clone,
offline, for the representative `x86_64-unknown-linux-gnu` — proving the compile
fetches nothing and changes neither dependency layout nor the lock, and that
target preparation itself leaves the host tree and lock untouched. It closes
with the concurrent interference proof: `deno task build:web` republishing the
generated module while Deno, Node and Bun resolve and read through the same
`node_modules` and import that module, followed by one comparison of tracked
files, `node_modules` and `deno.lock`. It runs no application suite — those are
the dedicated CI jobs `green` requires (AGENTS.md, #546).

Host preparation is `deno task deps`, which owns `node_modules/`, the cached
module graphs, and the `sideEffects` fact. Every job that builds, packages,
publishes, or releases the workspace runs it and then `deno task build:web`; a
release job adds target preparation on top, for the target it is compiling:

- **`ci.yml`'s `test-deno` job**, because the suite builds the CLI's npm artifact
  and dnt packages `@executablemd/web` along with it.
- **`ci.yml`'s `test-node` job**, before `pnpm install` rather than after:
  the Node typecheck resolves the module's literal dynamic import, and
  `deno task deps` rewrites `node_modules` into Deno's layout, so pnpm's install
  has to come last. The build between them changes nothing there.
- **`ci.yml`'s `jsr` job**, so the dry run validates the artifact the release
  uploads rather than a bundle-less variant of it.
- **`ci.yml`'s `smoke` job**, through the root `build` task, which chains the
  bundle build ahead of `deno compile`.
- **`publish-one.yml`**, unconditionally rather than only for `packages/web` —
  dnt builds a package's workspace siblings too.
- **`publish-packages.yml`'s `jsr` job**, generated from
  `scripts/gen-publish-workflow.md`.
- **`release.yml`**, before the matrix compile step. It invokes `deno compile`
  directly rather than through the root task, so it needs its own step.

Neither publishing nor compiling reports the omission. `deno publish` finds the
negated glob matching nothing and says so quietly; `deno compile` succeeds and
produces a binary that runs, serves a page, and cannot load its client. The
ordering is therefore asserted by test — `scripts/tests/publish-workflow-generator.test.ts`
for the JSR job and `scripts/tests/publish-workflow-membership.test.ts` for the
release workflow — and `ci.yml`'s smoke job serves a real form from the compiled
binary and reads the client asset back over HTTP, which is the only check that
can tell an embedded bundle from a missing one.

That job is where every claim about the *compiled* binary is proved, because
each one depends on `deno compile` having kept something: `scripts/smoke-foreground.ts`
for a foreground command's live output and exit status, `scripts/smoke-loaded-copy.ts`
for a declaration crossing into the bundled engine, and `scripts/smoke-fetch.ts`
for `<Fetch>` — a core component resolving from the module graph, requesting
through the contextual Fetch adapter, and binding a detached response, against a
loopback server the script owns. `scripts/tests/ci-workflow.test.ts` holds the
job to naming them, so removing a script is not a proof silently withdrawn.

A job that skipped the build fails with a module-not-found naming a path nobody
chose, which is why `packages/web/src/assets.ts` reports the missing bundle by
naming the command instead.

The module is gitignored, so `deno publish` excludes it by default and then
refuses the package: it sits in the module graph and would not exist at runtime.
`packages/web/deno.json` un-excludes it with a negated `publish.exclude` glob, so
the published package carries the bundle it needs while the repository still does
not track it.

Tree-shaking the dead runtime-validator path out of the bundle needs
`@rjsf/validator-ajv8` declared side-effect-free, which the package ships
without. `deno task deps` records that fact, and a build asserts it and fails
pointing at `deno task setup` when it is absent.

It is recorded on *every* installed copy, because the tree is a union of two
stores and which copy the bundler reads depends on how it resolves: Deno's
automatic mode reaches the root store, while `--node-modules-dir=manual`
resolves the way Node does and reaches pnpm's copy under
`packages/web/node_modules` — the difference between a 606 KB tree-shaken
bundle and a 734 KB one carrying `new Function`. `pnpm install` restores its own
copy from its store, so `deno task setup` records the fact after it rather than
before.

`scripts/lib/staged-write.ts` writes through a staged file named for the
invocation and renames it into place, so a concurrent preparation cannot delete
another's staging, a cancelled one waits for its own in-flight write before
removing it, and a reader sees either every old byte or every new one.

Bundling is Deno-only; the shape of the generated module is not. Its serializer
(`scripts/lib/web-client-module.ts`) touches no host, so
`scripts/tests/web-client-module.test.ts` loads generated modules and checks
their round-trip and byte-length contract under Deno, Node, and Bun.

A publishable `@executablemd/web` is an atomic configuration state: public
`deno.json` identity and `exports`, `private` cleared from `package.json`,
`build:web` run immediately before both JSR and npm packaging, and explicit
inclusion of `generated/client-bundle.ts` in both published artifacts. The
configuration elements change atomically; the package is never published
without its browser asset and never published while private.

### What a release must publish for `xmd upgrade`

`xmd upgrade` installs a published release into a standalone binary
([`xmd upgrade`](./upgrade-command-spec.md)), so what a release publishes is
also what a self-upgrade depends on:

- `packages/cli/src/release-targets.ts` owns the platform, architecture, target
  triple and exact artifact name of every published target. `release.yml`'s
  matrix and `scripts/lib/release-targets.ts` are held to that one table by
  `scripts/tests/release-targets.test.ts`, so the release and a self-upgrade can
  never choose different artifacts.
- Every published target has exactly one artifact, named exactly as that table
  names it, `.exe` included for Windows.
- `checksums.txt` carries exactly one SHA-256 entry per artifact, in GNU
  `sha256sum` format, whose filename is the artifact's exact basename.
- A release is not a valid self-upgrade source until every artifact and the
  checksum set are published. `release.yml` generates the checksums and
  publishes them with the binaries in the same step, and `fail_on_unmatched_files`
  refuses a partial set.
- A missing artifact for the current target, or a checksum set that does not
  name it exactly once, fails the upgrade closed. There is no fallback to
  another target, another release, or an unverified download.

## 9. Packaged documents (`@executablemd/cli`)

A document-backed command executes first-party Markdown through the ordinary XMD
engine rather than a TypeScript implementation. A package declares which Markdown it
ships by putting it in `src/documents/`; every other Markdown under `src/` —
test documents, scenario fixtures — stays out of the product. `xmd plan` is
the first such command, and it ships two: the checked-in Markdown is the
deployed artifact and the single source of truth, not a generated string mirror
of one.

- `packages/cli/src/documents/Plan.md` is the packaged `<Plan>` Component, which
  owns the Plan authorship workflow —
  every Prompt, the checking and repair loop, the review, the revisions, the
  approval and every ending. It is the public `<Plan>` component, so an ordinary
  document reaches the same bytes the command does.
- `packages/cli/src/documents/plan-command.md` is the command's root, and only
  its adapter: it projects the request into `<Plan>` and returns what comes
  back.

There is one Component source, and neither a generated TypeScript copy of it nor
a second Markdown implementation exists. That is what makes "the same workflow, whichever surface
asked" a fact about the file rather than a claim about two of them.

`xmd upgrade` is the second such command, and
`packages/cli/src/documents/upgrade-command.md` is the streaming text root it
executes. It ships through the same directory-wide mechanism and is read through
the same package-relative lookup; nothing about it is special-cased.

The command locates it from its own module URL — never from the contextual
working directory, and never through the component search path. Both are
answerable by whatever directory a person is standing in, and which Component the
command runs is not a thing a repository file may decide.

Every build therefore keeps the asset beside its module, at the same relative
path:

- **source checkout** — the file as committed;
- **`deno compile`** — embedded by one `--include packages/<name>/src/documents`
  per package, in `deno task build` and in `release.yml`'s matrix compile;
- **npm (dnt)** — copied by `scripts/build-npm.ts`, which copies each package's
  `src/documents/` into `esm/src/documents/`, preserving relative location. dnt
  emits the module graph and nothing else, so an asset no TypeScript imports is
  absent from the published package unless the build copies it. That failure is
  invisible under Deno and reaches only Node and Bun.

A missing asset fails loudly, naming the path it looked at, rather than
selecting different behavior.

The checks that hold this together, each proving a different build:

- `packages/cli/tests/packaged-document.test.ts` reads the document from a
  temporary working directory and compares it to the committed bytes. It runs
  under Deno, Node and Bun, which is what makes it evidence rather than one
  runtime's opinion.
- `scripts/tests/cli-npm-bin.test.ts` builds the real package, asserts every
  emitted `esm/src/documents/` asset is byte-identical to the source, and then
  asks the built bin — from a directory that is not the package — which Plan
  `<Plan>` Component source it would let a document write. The answer carries the
  origin and the SHA-256 of those bytes, so a build that shipped different ones, or none,
  answers differently here rather than at a person's first `xmd plan`.
- `scripts/tests/plan-component-compiled.test.ts` asks the same question of the
  compiled binary, which has no checkout to fall back to. It runs in the `smoke`
  job, beside the other suites whose subject is `dist/xmd`.
- `scripts/tests/packaged-document.test.ts` holds the two `deno compile` sites
  to the document *directories* that exist and are not empty, because which
  packages ship documents is the one thing no build discovers for itself.

Adding another packaged document to a package that already ships one needs no
build change at all: `build-npm.ts` copies the directory and each `deno compile`
site names it. A package that ships its *first* document adds one `--include` to
`deno task build` and to `release.yml`, which
`scripts/tests/packaged-document.test.ts` enforces.
