# Four interrupted attempts, and four states the retry meets

One document, staged twice, holding four independent requests. Each is at its
own position, so each has its own key and its own marker, and what happens to
one says nothing about the others.

<StagedRun id="run-296-issue" />
<Attempt as="attempt" />

The first attempt's process ends after the tracker has accepted each issue and
before it can journal anything about any of them. That is what makes the second
attempt a reconciliation rather than a replay.

<Interrupted when={attempt.number === 1} />

<GitHubServer as="server" />

Between the attempts, the tracker moves underneath the run. Issue 2 gains a
duplicate carrying its marker, issue 3 turns up in another repository, and
issue 4 is closed by somebody. The copy is made by the fixture rather than
written here, because a marker is a digest of a key.

<DuplicateIssue number={2} when={attempt.number === 2} />
<MoveIssue number={3} to="https://api.github.com/repos/octo/moved" when={attempt.number === 2} />
<CloseIssue number={4} when={attempt.number === 2} />

The first request meets a transport that will not answer on the retry, so its
own state stays unknown. It is written against a provider of its own, because a
transport fault is a property of the connection and not of the request.

<GitHubIssues
  ceiling={[server.repository]}
  endpoint={server.url}
  credential="valid"
  interruptsAfterCreate={attempt.number === 1}
  failsTransport={attempt.number === 2}
>
<IssueTracker url={server.repository}>
<PrintErrors>
<Issue title="Unanswered" as="unanswered">The transport stops answering.</Issue>
</PrintErrors>
</IssueTracker>
</GitHubIssues>

The other three retry over a transport that works, and meet the tracker as it
now is.

<GitHubIssues
  ceiling={[server.repository]}
  endpoint={server.url}
  credential="valid"
  interruptsAfterCreate={attempt.number === 1}
>
<IssueTracker url={server.repository}>
<PrintErrors>
<Issue title="Duplicated" as="duplicated">Two issues will carry this key.</Issue>
</PrintErrors>
<PrintErrors>
<Issue title="Moved" as="moved">This one turns up somewhere else.</Issue>
</PrintErrors>
<PrintErrors>
<Issue title="Closed" as="closed">Somebody closes this one.</Issue>
</PrintErrors>
</IssueTracker>
</GitHubIssues>
