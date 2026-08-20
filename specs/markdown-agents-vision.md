# Markdown Agents: Product Vision

- **Status:** Non-normative product direction
- **Audience:** Maintainers and contributors

This document records the product direction for agent authoring in
Executable.md. It guides design without defining the current runtime contract.
The syntax examples are illustrative; the executable MDX specification remains
the authority for implemented behavior.

## North star

Executable.md is the easiest way to write reliable, well-behaved, observable,
and composable agents whose source code is Markdown.

An agent document makes its orchestration readable. A reader can determine which
instructions an agent receives, which model acts, what context crosses an agent
boundary, how results flow into later steps, why execution repeats or stops, and
what output reaches the caller.

The central product idea is:

> The agentic control flow is the document.

Executable.md provides deterministic orchestration around nondeterministic model
calls. It does not claim that model responses are deterministic. It makes the
construction, ordering, boundaries, and provenance of those calls explicit.

## Product qualities

### Easy

- A useful agent starts as one readable Markdown file and runs with one command:
  `xmd run reviewer.md`.
- Common workflows do not require JavaScript, provider components, or knowledge
  of the execution engine.
- Defaults cover ordinary model invocation, instruction loading, output, and
  cleanup.
- Invalid agent names, providers, props, references, and structured outputs fail
  early with actionable diagnostics.

### Reliable

- Instructions are included explicitly and resolved by defined rules.
- Agent roles, providers, models, data dependencies, branches, and loop bounds
  appear in the document.
- Structured results are validated before later steps consume them.
- Timeouts, iteration limits, and explicit termination prevent accidental
  unbounded execution.
- Failures have defined propagation and output behavior.

### Well-behaved

- Work is scope-owned and cancelled when its enclosing operation ends.
- Providers, tools, permissions, budgets, and resources do not leak between
  agent or component scopes.
- Sensitive context crosses agent and provider boundaries only when explicitly
  selected.
- Expensive, destructive, or sensitive operations support visible approval
  boundaries.

### Observable

An execution record can explain:

- which instruction files were resolved and included;
- which agent, provider, and model handled each sample;
- what context and artifacts entered each call;
- which tools ran and what they returned;
- which values were captured;
- which branches and loop iterations executed;
- why the workflow completed, failed, or stopped; and
- what content was emitted as output.

Observability describes the real execution rather than an agent's self-report.

### Composable

- Components package reusable agent behavior without hidden global state.
- Named agents can be invoked from multiple workflow steps.
- Captured and structured results become inputs to later components.
- Nested components may override contextual behavior without affecting parents
  or siblings.
- Instructions, skills, tools, context transformations, and complete agents can
  be composed explicitly.

## Authoring model

The following examples express the intended experience. They are not a frozen
syntax contract.

### Deterministic repository instructions

```text
<Sample>
  <Agents />
</Sample>
```

`<Agents />` means that repository agent instructions are an explicit input to
the sample. Executable.md defines which applicable `AGENTS.md` files are read,
their precedence, and their order. The execution record identifies the exact
files and content used.

There is no host-dependent question about whether an agent discovers the
instructions or which file it chooses to read.

### Named agents and adversarial review

```text
<Agent provider="anthropic" model="opus" name="implementor">
  You are the implementor agent.
  <Agents />
</Agent>

<Agent provider="openai" model="gpt" name="reviewer">
  You are the reviewer agent.
  <Agents />
</Agent>

<Loop max={5}>
  <Sample agent="implementor">
    Refactor the requested subsystem.
  </Sample>

  <Sample agent="reviewer" as="result">
    Review the implementation and return a structured verdict.
  </Sample>

  <If condition={result.passed}>
    <Break />
  </If>
</Loop>
```

In this model:

- `<Agent>` declares a named, scoped configuration; declaration alone does not
  invoke the model.
- `<Sample agent="...">` invokes a specific declared agent.
- `as="result"` captures validated workflow data rather than relying on prose
  parsing by a later step.
- `<Loop>` makes bounded control flow visible: it repeats its body up to a
  limit, with `<Break />` ending the loop when a condition is met. This is
  distinct from collection iteration — the native `<Each in={list} let="item">`
  directive renders its body once per element of an array (see the executable
  MDX spec §6.5). `<Each>` walks data; `<Loop>`/`<Break>` bound retries and
  other repeated control flow.
- Conditional execution and `<Break />` make the termination rule part of the
  document.
- Control components perform contextual behavior; child expansion does not
  repair or rewrite an invalid parent structure.

## Context as workflow data

Context is an explicit value, not an invisible transcript shared by every agent.
An agent receives only the context passed to it.

Context can contain messages, structured results, files, tool output, source
references, and other artifacts. It retains provenance and sensitivity metadata
when it crosses agent or provider boundaries.

Context reduction has several distinct forms:

- **Summarization** preserves a shorter narrative.
- **Selection** keeps only information relevant to the next task.
- **Distillation** converts history into structured decisions, evidence, state,
  and open questions.
- **Externalization** stores large material as artifacts and passes references.
- **Deduplication** removes repeated instructions and unchanged content.

Compression is explicit, observable, and non-destructive. It creates a derived
context while leaving the source context addressable. Its record includes the
source, instructions, strategy, model when applicable, token counts, and
resulting artifact.

Structured distillation is preferred when later control flow depends on the
result. Free-form summaries are useful context, but they are not substitutes for
validated workflow state.

## Workflow-owned development artifacts

A development workflow owns its material environment and logical run state.
Worktrees, working directories, captured handoffs, implementation plans,
feedback, decisions, branches, and pull requests do not belong to whichever
agent happened to create them. The document captures or resolves those assets
deterministically and passes required content into agent prompts explicitly.

`<File>` and `<Glob>` already perform such operations, and the command already
supplies the run around them: `xmd workflow start` creates a workflow run with
one retained Workspace and `xmd workflow resume` continues it from the retained
journal (#366, shipped). The composition inside that run is there too: named
`<Repository>`, `<Worktree>` and lexical `<Dir>` are registered by the workflow
host (#293, shipped). The durable effects are there too: deterministic
local Git effects (#294), explicit `<Git.Push>` (#495), and `<PullRequest>`
(#295) are all registered by the workflow host. `<Issue>` (#296) is the one that
is still not built. Together they cover the work that should not depend on model
judgment:

- retain each handoff, plan, review, and decision as a filtered journal event
  bound to the Workspace root current when it was written;
- create or resolve a named repository, worktree, branch, file, or pull request
  only when that environmental asset is needed;
- establish the working directory inherited by child operations;
- read and write exact content through the contextual filesystem boundary;
- return paths, commit identities, pull-request numbers, and URLs as workflow
  data;
- reconcile existing external state when an execution resumes; and
- record the inputs, observed state, effects, and outputs of each operation.

Agent calls analyze evidence and propose changes; they do not perform them. Under
a workflow run an Agent reaches no checkout at all, and a proposal reaches the
Workspace as generated XMD that a constrained evaluator preflights completely
and expands as ordinary durable effects. That evaluator is built for observation
(#497) — pinned identities, exact request ceilings, one retained admission — and
what is still owed is admission for a mutating fragment, the bounded
request/result loop an Agent observes the repository through (#302), and the
public component a document writes to reach either (#369). Deterministic components apply approved
environmental changes and provide exact required content to the next call.
Generated files are optional exports rather than the handoff protocol. This
removes manual copying between agent-owned transcripts, plan files, and working
directories.

Live run state is scoped to the operation that owns it: created inside the
operation it describes, provided contextually, and torn down with it. Nothing
accumulates runs in a module-scoped registry, so concurrent runs cannot observe
each other. What outlives the process is retained deliberately, in the run's own
store, addressed by a public run ID.

Resources clean up with their enclosing execution by default. Agent sessions,
processes, streams, and other ongoing effects always stop. Cleanup releases live
attachments without deleting run-owned state: every run status is retained until
an explicit deletion, so a failed or cancelled execution keeps its checkouts and
its journal, and reports the path, branch, and reason that recovery is required.
Durable published results such as commits, issues, and pull requests remain
addressable after scoped resources close.

## Living workflows with `xmd play`

`xmd run` executes a fixed document. `xmd play` treats the document as a living
collaborative workspace:

```sh
xmd play workflow.md
```

The executable document, rather than a hidden conversation, is the shared source
of workflow intent and progress. Agents propose visible document changes or new
executions. The runtime validates proposals, enforces policy, and performs
deterministic effects. The user approves material changes and remains the final
authority for product behavior, scope, architecture, risk, and lasting
constraints.

An accepted proposal becomes an inspectable document revision. Rejected
proposals, failed executions, reviewer rejections, and later successful attempts
retain their provenance so the engineering history explains how the workflow
changed. Hidden session history may help an agent reason, but it is never the
only source of consequential workflow state.

Named agent sessions remain scope-owned while Play is active. Each invocation
receives explicit workflow context and references to workflow-owned artifacts.
The document and execution record identify what each agent received, what it
proposed, what the runtime applied, and which user decision authorized a
material transition.

Play rests on the same deterministic asset and agent orchestration needed by an
automated implementation loop. The loop is the proving ground for worktree,
file, pull-request, review, decision, cleanup, and recovery semantics. Play adds
collaborative document evolution after those operations are reliable; it does
not replace them with agent-managed shell work.

## Foundation and agent layer

Executable.md separates two concerns:

1. The execution foundation provides component expansion, contextual APIs,
   scoped resources, evaluation, controlled output, and execution records.
2. The agent authoring layer provides opinionated components for agents,
   instructions, tools, skills, structured samples, context management, and
   explicit control flow.

The easy authoring experience builds on the foundation without exposing its
mechanics in ordinary agent documents. New agent capabilities should compose
through components and contextual APIs instead of adding unrelated special cases
to the expansion engine.

Composing with the foundation is not the same as deciding for it. Public
middleware around an execution or a document expansion may inspect what it is
given, narrow it, install contextual behavior, refuse, and delegate; canonical
core alone brings that execution or expansion into being and publishes its
outcome, so no composed layer can substitute a document, an output stream, a
success, or a failure (#432, #433).

## Relationship to Agent Skills

[Agent Skills](https://agentskills.io/) packages reusable instructions, scripts,
references, and assets that an agent can load. Executable.md defines and runs
the explicit orchestration in which agents and capabilities participate.

The concepts are complementary:

- Agent Skills packages reusable procedural knowledge.
- Executable.md composes agents, instructions, model calls, dataflow, context,
  and control flow into an inspectable workflow.

Executable.md can consume standard skills explicitly without defining a
competing skill format. Skill inclusion remains visible in the agent document
and execution record rather than depending on heuristic activation.

## Design test

A design supports this direction when a reader can answer, from the document and
its declared props:

1. Which agents exist, and what configures each one?
2. What exact instructions and context does each invocation receive?
3. Which model, provider, and tools can it use?
4. How does its result become data for the next step?
5. What bounds its cost, lifetime, and iteration?
6. What happens when it fails or returns invalid output?
7. Why did the workflow take a branch or stop?
8. What evidence in the execution record supports those answers?
9. Which environmental assets did the workflow create or resolve, and who owns
   their cleanup or retention?
10. In Play, what document change was proposed, what effects were validated, and
    which user decision accepted it?

If those answers depend on hidden host behavior, implicit transcript sharing, or
an agent's own account of what it did, the design does not satisfy the product
goal.
