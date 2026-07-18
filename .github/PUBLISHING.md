# Publishing `@executablemd` packages

Pushing a `vX.Y.Z` tag runs two workflows: `release.yml` compiles the `xmd`
binaries, and `publish-packages.yml` publishes every `@executablemd/*` library
to npm (primary) and JSR (secondary). `publish-packages.yml` is generated from
the manifests by `scripts/gen-publish-workflow.ts` and calls the reusable
`publish-one.yml` once per package, ordered by `needs:` so dependencies publish
before dependents. `publish-packages.yml` also runs manually via
`workflow_dispatch` with a `tag` input.

## Packages

- `@executablemd/durable-streams`
- `@executablemd/runtime`
- `@executablemd/code-review-agent`
- `@executablemd/core`
- `@executablemd/cli`

## npm authentication (OIDC, no token)

`publish-one.yml` authenticates to npm with GitHub Actions OIDC trusted
publishing; the repo holds no npm token. Each package has a trusted publisher
configured at npmjs.com → the package → **Settings → Trusted Publisher →
GitHub Actions**:

| Field                | Value                   |
| -------------------- | ----------------------- |
| Organization or user | `taras`                 |
| Repository           | `executable.md`         |
| Workflow filename    | `publish-packages.yml`  |
| Environment name     | _(empty)_               |
| Allowed actions      | `npm publish`           |

The workflow filename is the **calling** workflow (`publish-packages.yml`), not
the reusable `publish-one.yml`: for `workflow_call` / `workflow_dispatch`, npm
validates the caller's filename.

The npm account owns the `@executablemd` scope, and packages publish public
(`npm publish --access public`).

## Adding a new package

npm exposes trusted-publisher settings only on a package that already exists, and
the workflow carries no npm token, so a brand-new package is bootstrapped by hand
once:

1. Make it a workspace member: add its directory to `workspace` in the root
   `deno.json`, give it a `deno.json` whose `name` is under `@executablemd`, and
   a `package.json` declaring its dependencies (`workspace:*` for internal
   `@executablemd` siblings). `gen-publish-workflow.ts` then picks it up
   automatically — run `deno task gen:publish-workflow` and commit the result
   (CI fails if `publish-packages.yml` is stale).
2. Publish its first version by hand, as a maintainer who is logged in to npm
   (`npm login`) and owns the `@executablemd` scope:
   ```sh
   deno run -A scripts/build-npm.ts <package-dir> <version>
   ( cd <package-dir>/npm && npm publish --access public )
   ```
3. Configure the trusted publisher on the now-existing package with the table
   above.
4. Optionally create/link the package on jsr.io (JSR is best-effort and does not
   fail the run).

Every later release publishes the package automatically over OIDC.

## Consumer note

`@executablemd/core`, `@executablemd/runtime`, and `@executablemd/cli` depend on
effection's 4.x prerelease, which npm's peer resolver rejects against
`@effectionx/*` (`^3 || ^4`). Installing them needs `--legacy-peer-deps` until
effection 4 is stable.
