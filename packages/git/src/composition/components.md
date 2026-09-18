Long-form documentation for the repository-composition components.

Thirteen components for working with repositories, branches, pull requests and
issues from inside a document. They are mostly *regions*: `<Repository>`,
`<Worktree>` and `<Dir>` establish where the work happens, and the `Git.*`,
`PullRequest.*` and issue components act inside whatever those established.

The pattern to hold onto is that a document says *what* it wants — this
repository, this branch, this commit — and the components decide whether that
means creating something or using what is already there. Running one twice does
not make two.

## Repository

Clones a repository, or uses the clone already there.

```mdx
<Repository name="project" url={props.repository}>
…
</Repository>
```

A region: its content runs with that repository as the working directory.
`name` identifies the checkout across runs, so a second run reuses the first's
rather than cloning again, and `url` says where it comes from.

The checkout survives the run. Nothing here deletes, resets, cleans or repairs
one — a document that wants a clean tree asks for it explicitly.

## Worktree

Creates a linked checkout, or uses the one already there.

```mdx
<Worktree name="review" branch="issue-643">
…
</Worktree>
```

A region, expanding its content in the worktree. Use it to work on a branch
without disturbing the main checkout — two worktrees of one repository can be on
two branches at once, which is what makes a document that reviews one branch
while building another possible.

`as` captures the path of the linked checkout, for a step that needs to name it.

## Dir

Changes the working directory for its content.

```mdx
<Dir path={worktree}>
…
</Dir>
```

The plainest of the three regions: no repository, no branch, just a directory.
It pairs naturally with `<Worktree as="…">`, which hands you a path this can
then work inside.

## Git.Switch

Switches to a branch, creating it if it does not exist.

```mdx
<Git.Switch branch="release/1.4" base="main" />
```

`base` says what a *new* branch starts from; it is ignored when the branch
already exists, so the same element is correct on the first run and on the
tenth. Self-closing, and it renders nothing.

## Git.Add

Stages paths for commit.

```mdx
<Git.Add paths={["packages/core", "deno.lock"]} />
```

`paths` is a list, so one element stages everything a step produced. Staging is
explicit rather than implied by `<Git.Commit>` because a document that commits
everything it happens to have touched is a document that commits surprises.

## Git.Commit

Commits what is staged.

```mdx
<Git.Commit>Prepare 1.4</Git.Commit>
```

The content is the commit message, so a message can be as long as it needs to be
and can interpolate what the document learned. Commits only what `<Git.Add>`
staged.

## Git.Push

Publishes the current branch.

```mdx
<Git.Push />
```

Self-closing. Pushes the branch the working tree is on, to the remote the
repository was cloned from — so which branch is decided by `<Git.Switch>` above
it rather than repeated here.

## PullRequest

Opens a pull request, or updates the one already open.

```mdx
<PullRequest title="Prepare 1.4">
What changed, and why.
</PullRequest>
```

The content is the body. Opening and updating are one element for the same
reason cloning and reusing are: a document that runs twice should end in the
state it describes, not with two pull requests.

Push the branch first — `<Git.Push />` — since there is nothing to open a pull
request against until the branch exists on the remote.

## PullRequest.Reviews

Reads the reviews on a pull request.

```mdx
<PullRequest.Reviews url={pullRequest.url} as="reviews" />
```

`as` is required: this is a read, and the reviews are the result. Use it to let
a document act on what people said — hold a release until an approval lands, or
collect the changes a reviewer asked for.

## PullRequest.Comments

Reads the comments on a pull request.

```mdx
<PullRequest.Comments url={pullRequest.url} as="comments" />
```

Comments rather than reviews: the discussion, including comments that carry no
verdict. `as` is required.

## PullRequest.Checks

Reads the check results on a pull request.

```mdx
<PullRequest.Checks url={pullRequest.url} as="checks" />
```

`as` is required. This is what a document branches on when it should only
proceed once CI is green — read the checks, then decide, rather than merging and
hoping.

## IssueTracker

Selects the issue tracker its content works with.

```mdx
<IssueTracker url={props.tracker}>
…
</IssueTracker>
```

A region, like `<Repository>` above it: the issue components inside it resolve
against this tracker. A document that touches two trackers writes two regions
rather than repeating the URL on every element.

## Issue

Reads an issue, or files one.

```mdx
<Issue url={finding.issueUrl} as="found" />

<Issue title="Retry the publish step">
What failed, and what to try.
</Issue>
```

The self-closing form with `url` reads an existing issue and binds it. The
paired form with `title` files a new one, with the content as the body — which
is how a document that finds something wrong can record it where the next person
will look.
