Long-form documentation for the components the testing package registers.

Two components, and they work together: `<Testing>` turns testing on for a
region, and `<AssertThrows>` states that a piece of work is *supposed* to fail.
The cases themselves are written with core's `<Test>`, which is inert until one
of these — or `xmd test` — asks for them.

## Testing

Turns on testing for its content.

```mdx
<Testing>
<Test name="parses a manifest">
…
</Test>
</Testing>
```

Runs the `<Test>` elements inside and reports them. Two things fail the
document: a failing test, and finding **no tests at all** inside the region.
The second is deliberate — a testing region that silently matched nothing is
indistinguishable from one that passed, and a document whose tests stopped being
discovered should say so rather than go green.

`<Test>` outside a testing region is skipped, so a document can carry its tests
and still be run as an ordinary document.

## AssertThrows

Asserts that its content fails.

```mdx
<AssertThrows message={/not found/}>
<File path="absent.md" />
</AssertThrows>
```

Passes only if the content fails *and* the failure message matches. `message` is
required and takes a string or a regular expression — required rather than
optional because an assertion that any failure will do passes for the wrong
reason as readily as the right one, and the message is what tells the two apart.

Use it to pin a refusal you rely on: that a bad path fails, that an invalid
schema is rejected, that a guard actually guards.

## Assert

Asserts that a value is truthy.

```mdx
<Assert expr={ready} msg="the release should be ready by now" />
```

The base assertion. `msg` replaces the reported failure message, which is worth
writing whenever the expression alone would not tell a reader what went wrong.

A passing assertion renders a diagnostic report only while testing or verbose
output is on, so an assertion inside an ordinary run is silent when it holds. A
failing one does not return.

## AssertFalse

Asserts that a value is falsy.

```mdx
<AssertFalse expr={hasConflicts} />
```

The complement of `<Assert>`. Prefer it over asserting `!value`, which reads as
a double negative at the point where a reader is trying to work out what should
be true.

## AssertExists

Asserts that a value is neither null nor undefined.

```mdx
<AssertExists actual={user} />
```

Narrower than `<Assert>` on purpose: `0`, `""` and `false` are all falsy and all
perfectly present, so an existence check written as a truthiness check fails on
legitimate values.

## AssertEquals

Asserts that two values are deeply equal.

```mdx
<AssertEquals actual={count} expected={3} />
```

Deep equality, so objects and arrays compare by content rather than identity.
The expected value may also be written as content, which is easier to read when
it is large:

```mdx
<AssertEquals actual={config}>
{"name": "release", "steps": 3}
</AssertEquals>
```

## AssertNotEquals

Asserts that two values are not deeply equal.

```mdx
<AssertNotEquals actual={after} expected={before} />
```

Use it to pin that something actually changed — a step that is supposed to
rewrite a file, or a retry that should not return the first answer again.

## AssertStrictEquals

Asserts that two values are the same, compared with `===`.

```mdx
<AssertStrictEquals actual={handle} expected={original} />
```

Identity rather than content. This is the assertion for "the same object", where
`<AssertEquals>` would pass for a copy.

## AssertNotStrictEquals

Asserts that two values are not the same, compared with `===`.

```mdx
<AssertNotStrictEquals actual={copy} expected={original} />
```

The counterpart: pins that something was copied rather than shared, which is
what you want when a later step is going to mutate one of them.

## AssertMatch

Asserts that a string matches a pattern.

```mdx
<AssertMatch actual={message} expected={/already exists/} />
```

For output whose exact text is not the contract — a message that carries a path,
a timestamp, or a count. Match the part that is the contract and leave the rest
free.

## AssertNotMatch

Asserts that a string does not match a pattern.

```mdx
<AssertNotMatch actual={rendered} expected={/SECRET/} />
```

Useful for the absence of something: that a rendering leaked no token, that a
diagnostic did not reach a user-facing surface.

## AssertStringIncludes

Asserts that a string contains a substring.

```mdx
<AssertStringIncludes actual={output} expected="Prepare 1.4" />
```

The plainer form of `<AssertMatch>` when what you are looking for is literal
text rather than a shape.

## AssertGreater

Asserts that one number is greater than another.

```mdx
<AssertGreater actual={score} expected={80} />
```

## AssertGreaterOrEqual

Asserts that one number is greater than or equal to another.

```mdx
<AssertGreaterOrEqual actual={score} expected={80} />
```

The inclusive form. Reach for it when the boundary value is acceptable — a
threshold that is met exactly is usually met.

## AssertLess

Asserts that one number is less than another.

```mdx
<AssertLess actual={elapsed} expected={5000} />
```

## AssertLessOrEqual

Asserts that one number is less than or equal to another.

```mdx
<AssertLessOrEqual actual={failures} expected={0} />
```

## Execution

Runs another document from inside a test, and asserts on how it finished.

```mdx
<Execution host="run" target="./scripts/bootstrap.md" props={{ name: "x" }} as="run">
<AssertEquals actual={run.output} expected="done" />
</Execution>
```

The child is real: its own journal, its own output, its own lifecycle. Pass
`source` instead of `target` to supply the Markdown directly, and `props` for
the child's properties.

`as` binds the child's outcome — a settled result, or a suspension. Bind it:
**without `as`, a settled failure fails the owning test rather than passing
vacuously**, which is the safe direction but not usually what you meant to
write. The content is the child's declarations, then the assertions about it.

## WorkflowRun

Scopes a workflow-hosted execution.

```mdx
<WorkflowRun>
<Execution host="workflow" source={document} as="run">
…
</Execution>
</WorkflowRun>
```

A region that owns the workflow-hosted executions inside it, so a test that
drives a workflow has somewhere for that run's resources to belong and be torn
down.

## DiagnosticJournal

Gives a child execution a journal of its own.

```mdx
<Execution host="run" source={document} as="run">
<DiagnosticJournal />
<CollectJournal as="events" />
</Execution>
```

Goes inside `<Execution>`, before the assertions, and is **invalid anywhere
else**. Pair it with `<CollectJournal>`: this creates the journal, that reads
it.

## CollectOutput

Captures a child execution's output so a test can assert on it.

```mdx
<Execution host="run" source={document} as="run">
<CollectOutput as="printed" />
<AssertStringIncludes actual={printed} expected="done" />
</Execution>
```

Goes inside `<Execution>`, before the assertions, and is invalid anywhere else.
`as` is required. It changes nothing about the run, and a child that fails
partway still leaves what it printed — which is often exactly what the test
needs to see.

## CollectJournal

Captures a child execution's journal so a test can assert on it.

```mdx
<Execution host="run" source={document} as="run">
<DiagnosticJournal />
<CollectJournal as="events" />
</Execution>
```

Placed like `<CollectOutput>`, and `as` is required. It reads a journal the run
already has — pair it with `<DiagnosticJournal>` to create one.
