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
- `<Loop>` makes iteration visible and bounded.
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
its declared inputs:

1. Which agents exist, and what configures each one?
2. What exact instructions and context does each invocation receive?
3. Which model, provider, and tools can it use?
4. How does its result become data for the next step?
5. What bounds its cost, lifetime, and iteration?
6. What happens when it fails or returns invalid output?
7. Why did the workflow take a branch or stop?
8. What evidence in the execution record supports those answers?

If those answers depend on hidden host behavior, implicit transcript sharing, or
an agent's own account of what it did, the design does not satisfy the product
goal.
