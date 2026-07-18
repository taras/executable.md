# CI/CD security hardening

Threat model: a contributor's PR must not be able to steal tokens or alter
release/publish behavior without review, and a compromised collaborator
account must not be able to publish unreviewed code.

Two properties hold by construction today: PR review runs on `pull_request`
(never `pull_request_target`), so fork PRs get no secrets and a read-only
`GITHUB_TOKEN`; and the publish path holds no npm token (OIDC trusted
publishing only).

## Do now — in the repo

- [x] Pin every third-party action to a full commit SHA (tags are mutable;
      a compromised action publisher otherwise reaches privileged workflows).
- [x] `publish-one.yml` runs its job in the `npm-publish` environment, so
      GitHub environment protection rules gate every package publish.
- [x] `EnsureOxlint` verifies a pinned sha256 for each downloaded tarball and
      fails closed, matching `install.sh`. Version pins live next to their
      hashes in the component, not as overridable props.
- [x] `review.yml` / `repo-analysis.yml` pin the released binary with
      `XMD_VERSION` instead of tracking "latest" (a bad or malicious release
      no longer changes PR-review behavior silently). Bump the pin as part of
      each release.
- [x] `GitHubComment` reads `GITHUB_TOKEN` inline at each fetch call instead of
      binding it — eval bindings are journaled, and `review.yml` uploads the
      journal as an artifact that any logged-in user can download on a public
      repo. Log masking does not apply to artifact contents.

## Do now — repository/npm settings (owner)

- [x] Create the `npm-publish` GitHub environment with required reviewers and a
      deployment branch/tag rule allowing only `v*` tags. Without this, anyone
      with write access can `workflow_dispatch` the publish from an unreviewed
      branch; npm's trusted publisher validates only repo + caller workflow
      filename, so it would mint a token for it.
- [x] Add the environment name (`npm-publish`) to each package's npm
      trusted-publisher configuration so npm rejects tokens minted outside it.
- [ ] Rulesets: require PRs into `main`; restrict `v*` tag creation.
- [ ] Actions settings: require approval for all outside collaborators (the
      review executes documents from the PR by design); set default workflow
      permissions to read-only.

## Do later

- [ ] Scrub the journal before artifact upload (redact values of known secret
      env vars), or stop uploading journals for PR runs.
- [ ] Decide whether `publish-packages.yml` keeps `workflow_dispatch` once the
      environment gate exists.
- [ ] `repo-analysis.yml` executes documents from the dispatched `inputs.ref`;
      run them from `main` instead, or environment-gate the workflow.
- [ ] npm `--provenance` on publish; artifact attestations for release
      binaries; binary signing/notarization (#68).
- [ ] Embed `core/components` in the binary (#83) — shrinks the PR-controlled
      execution surface.

## Probabilistic hardening — AGENTS.md rules for agents

Rules to add to AGENTS.md so future agents do not erode the posture:

1. Never assign a secret (`process.env.*TOKEN`, keys) to an eval binding in a
   document or component — read it inline at the point of use. Bindings are
   journaled and journals may be uploaded as artifacts.
2. Never use `pull_request_target`; never add secrets to a
   `pull_request`-triggered workflow.
3. Every workflow declares a least-privilege `permissions:` block; widening one
   must be called out in the PR description.
4. Third-party actions are pinned to full commit SHAs.
5. Downloaded binaries are version-pinned and sha256-verified, fail closed.
6. Publish jobs keep their `environment:` gate; no new secrets-bearing
   `workflow_dispatch` paths.

## Deterministic hardening — CI gates

Mechanical checks that catch violations of the rules above (the staleness check
for the generated publish workflow is the existing example of this pattern):

- [ ] Run `zizmor` over `.github/workflows/` in CI (catches
      `pull_request_target`, unpinned actions, injection patterns, missing
      permissions).
- [ ] Fail CI if any `uses:` references a tag/branch instead of a 40-char SHA.
- [ ] Fail CI if any eval block under `.reviews/` or `core/components/` assigns
      `process.env.<SECRET>` to a binding.
- [ ] Fail CI if a component fetches a URL without an adjacent sha256 check.
- [ ] Scan `journal.jsonl` for token prefixes (`ghs_`, `ghp_`, …) before
      artifact upload and fail on a hit — the backstop for rule 1.
