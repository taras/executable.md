Long-form documentation for the repository-composition components.

Sixteen components for working with repositories, branches, pull requests and
issues from inside a document. They are mostly *regions*: `<Repository>` and
`<Worktree>` establish where the work happens, and the `Git.*`,
`PullRequest.*` and issue components act inside whatever those established.
`<Dir>` works the same way inside them and is canonical core's, so it is
documented with the components core owns.

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

## Git.Files

Lists the tracked files of the repository in scope.

```mdx
<Git.Files prefix="packages/core/" limit={100} as="files" />
```

`as` is required: this is a read, and the paths are the result. Only tracked
files are listed — an untracked file, and anything inside a nested or sibling
checkout, is not part of this repository's index and does not appear. `prefix`
is literal text, so `packages/co` lists everything whose path starts that way
and a prefix containing `*` matches a path with a `*` in its name.

A page holds 100 paths unless you ask for more, and `next` holds the complete
arguments of the read that continues it — pass them straight back. When the
listing has changed in between, the continuation says so and asks you to start
again rather than stitching two different answers together.

## Git.Changes

Reports what changed, path by path.

```mdx
<Git.Changes compare="staged" as="changes" />
<Git.Changes compare="commits" base={release.commit} head="HEAD" as="shipped" />
```

Three comparisons: `unstaged` is the index against the working tree, `staged` is
HEAD against the index, and `commits` compares the two commits `base` and `head`
name directly — not their merge base. Each change carries Git's own letter for
what happened to it, and a rename carries the path it came from, so a document
can tell a move from a delete and an add.

`paths` narrows the result to literal files and directories. A rename matches on
either side, and `paths={[]}` selects nothing at all — which is different from
leaving it out, and means it.

## Git.Diff

Reads the patch one comparison produces.

```mdx
<Git.Diff compare="staged" paths={["packages/core/"]} offset={0} limit={4096} as="diff" />
```

The same three comparisons as `<Git.Changes>`, answering with unified diff text
instead of a list. A window holds 4096 characters unless you ask for more, and
`length` is how long the whole patch is, so a document can tell how much it has.
Binary changes keep Git's binary marker and a mode change shows as patch
metadata: this is the patch, not a summary of it.

Use it to show a reviewer what a comparison contains. For deciding *which*
files to look at, `<Git.Changes>` answers that with a list rather than text to
search.

## Git.File

Reads a file as one commit holds it.

```mdx
<Git.File commit="HEAD~1" path="packages/core/src/expand.ts" offset={0} limit={4096} as="source" />
```

The commit's own bytes, not the working copy — which is what lets a document
compare what shipped with what is there now, after somebody has already edited
the file. The result names the full commit id the revision resolved to, and a
continuation stays on that exact commit even if the branch moves under it.

A window holds 4096 characters unless you ask for more, counted so that a
character is never split across two reads. A path the commit does not hold, a
directory, and a file that is not text each refuse and say which it was.

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
