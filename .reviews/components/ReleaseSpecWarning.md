---
inputs:
  files:
    type: array
    required: true
---

# Release Config Files

The following is the list of files used in the release process. Update this
list when a file is added or removed.

<Capture as="releaseConfigFiles">

- .github/workflows/draft-release.yml
- .github/workflows/release.yml
- .github/workflows/publish-one.yml
- .github/workflows/publish-packages.yml
- .github/release-drafter.yml
- scripts/gen-publish-workflow.md
- scripts/build-npm.ts
- scripts/bump-version.ts

</Capture>

```ts eval
const releaseChanged = files.filter((path) => releaseConfigFiles.includes(`- ${path}`));
const changedList = releaseChanged.join(", ");

// TODO: evaluate whether the diff's changes are actually reflected in the
// spec document, not just whether the spec file was touched.
```

<Output>

<Show when={releaseChanged.length > 0 && !files.includes("specs/release-process-spec.md")}>

> [!WARNING]
> This PR changes release configuration ({changedList}) without touching
> `specs/release-process-spec.md`. Review the spec and update it to match, or
> state `spec-reviewed: no changes needed` in the PR description (AGENTS.md
> rule 8).

</Show>

</Output>
