Long-form documentation for the code-review agent's TypeScript components.

Six components that gather the evidence a review reasons about: the pull request
and its diff, the checkout's readiness, the Oxlint sensor's diagnostics, the
repository's source inventory, and the review comments already on the pull
request. Each one *reads* — none of them writes a comment, pushes a branch or
changes a file.

They are reserved: this package claims these six names, so a repository under
review cannot supply its own `ReviewContext.ts` and have a review run it. The
Markdown components that compose them are declared by this package for the same
reason, and are documented by their own bodies rather than here.

Every one of them runs against the working directory. A review of another
checkout establishes that checkout first — with `<Worktree>` or `<Dir>` — and
these report on whatever is current.

## ReviewContext

Builds the review's subject: which revisions are being compared, and what changed
between them.

```mdx
<ReviewContext as="review" />
```

Reads the local Git checkout for the configured base and head revisions and binds
the pull-request metadata together with the changed file paths. This is normally
the first thing a review document does, because almost everything downstream is
scoped to the files it names.

Where a pull request is available, the metadata comes from it; where one is not,
the revision range still describes the comparison, so a review of a local branch
works the same way.

## Doctor

Reports whether this checkout can actually be analyzed, before a review depends
on it.

```mdx
<Doctor pr={pr} as="doctor" />
```

Probes for the pinned Oxlint sensor and its type-aware companion, decides whether
TypeScript analysis is available, and lists the files that would be analyzed. The
binding carries actionable setup guidance, so a document can show a person what
to install rather than failing with an absence.

Use it to branch: a review that finds the sensor unavailable can report that
plainly instead of reporting a clean result it never measured.

## OxlintDiagnostics

Runs the pinned Oxlint sensor over selected files and returns what it found.

```mdx
<OxlintDiagnostics files={paths} typeAware as="diagnostics" />
```

The diagnostics are normalized, so a document reads one shape regardless of the
sensor's own output format. `typeAware` selects the type-aware pass, which needs
the TypeScript support `<Doctor>` reports on.

It fails rather than returning nothing when the sensor crashes or emits output it
cannot use. A silent empty result would be indistinguishable from a clean run,
and a review that reported "no findings" because its sensor died is worse than
one that stopped.

## RepositoryInventory

Counts what is in the repository, for a review that reasons about the whole tree
rather than a diff.

```mdx
<RepositoryInventory as="repository" />
```

Selects the repository's source paths and binds them with their file and line
totals. Repository analysis uses it for ratios and thresholds — how much of the
tree a signal covers, whether a count is large relative to what is there.

## CommentReviewData

Collects the review comments already on the pull request, and what was said back.

```mdx
<CommentReviewData pr={pr} as="data" />
```

Binds the review-comment pairs, the findings a previous run recorded, and the
replies grouped by the comment they answer. It is the input to deciding which of
a previous review's findings still stand — a review that could not see its own
earlier comments would repeat every one of them on each run.

## CommentReviewState

Decides what the pull request's review comments should become, given the
classified evidence.

```mdx
<CommentReviewState
  pr={pr}
  data={data}
  classificationResult={classification}
  sampleResult={sample}
  as="state"
/>
```

Takes the collected comment data together with the classification of it and binds
the checklist text, the findings still pending, and the replies that dismiss the
ones that are not. It decides; it does not post. What a document does with the
result — write a comment, render a report, do nothing — is the document's.
