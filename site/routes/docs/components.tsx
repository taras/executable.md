import { define } from "../../utils.ts";
import { CodeBlock } from "../../components/Code.tsx";

const COMPONENT = `---
emoji: Hello
props:
  name:
    type: string
    required: true
---

{meta.emoji}, {props.name}!`;

const SLOT = `<Card title="Notes">
  Anything here becomes the card's children.
</Card>`;

const VALUE_COMPONENT = `---
returns:
  passed: { type: boolean }
  summary: { type: string }
---

\`\`\`js eval
const verdict = { passed: true, summary: "no findings" };
\`\`\`

<Return value={verdict} />`;

const VALUE_CAPTURE = `<Review as="review" />

<If condition={review.passed}>
Review passed: {review.summary}
</If>`;

const VALUE_ROOT = `$ xmd run review.md
{"passed":true,"summary":"no findings"}`;

const TS_COMPONENT = `import { useContent } from "@executablemd/core";

export const props = {
  type: "object",
  properties: { title: { type: "string" } },
  required: ["title"],
  additionalProperties: false,
} as const;

export default function*(props) {
  const directory = yield* useTempDir();
  const body = yield* useContent();
  return \`## \${props.title}\\n\\n\${body}\`;
}`;

const RETAIN_COMPONENT =
  `import { hasContent, retain, useContent } from "@executablemd/core";

export default function*() {
  if (yield* hasContent()) {
    // A wrapper: the resource is alive exactly while the content expands.
    yield* useThing();
    return yield* useContent();
  }
  // Standalone: the caller uses this handle after the invocation is over.
  return yield* retain(useThing);
}`;

const RETAIN_USAGE = `<Thing as="handle" />

The resource behind {handle} is still running here.`;

const TEMPDIR = `<TempDir>
\`\`\`sh exec
pwd
\`\`\`
</TempDir>`;

const TEMPDIR_STANDALONE = `<TempDir as="workspace" />

Files written under {workspace} live until the document ends.`;

const PARSE = `<Capture as="schema" select="code[lang=json]">
\`\`\`json
{
  "type": "object",
  "properties": { "passed": { "type": "boolean" } },
  "required": ["passed"]
}
\`\`\`
</Capture>

<Parse schema={schema} as="verdict">
  <Prompt>Answer with JSON only: did the change pass review?</Prompt>
</Parse>

Review passed: {verdict.passed}`;

const SAFE_PARSE = `<SafeParse schema={schema} as="result">
  <Prompt>Answer with JSON only: did the change pass review?</Prompt>
</SafeParse>`;

const REPAIR = `<SafeParse schema={schema} as="result">
  <Prompt>Answer with JSON only: did the change pass review?</Prompt>
</SafeParse>

<If condition={result.ok}>

Review passed: {result.value.passed}

<Else>

That first answer was not usable:

\`\`\`
{result.input}
\`\`\`

<Each in={result.errors} let="issue">
- {issue.instancePath} {issue.message}
</Each>

<Parse schema={schema} as="verdict">
  <Prompt>Correct the JSON above so it satisfies every point.</Prompt>
</Parse>

Review passed: {verdict.passed}

</Else>
</If>`;

export default define.page(function Components() {
  return (
    <>
      <h1 style="font-size:2rem;font-weight:800;">Components</h1>
      <p class="muted">
        A component is a markdown file with frontmatter and declared props,
        invoked with a JSX-style tag. Documents stay valid, readable markdown
        everywhere.
      </p>

      <h2>Defining a component</h2>
      <p>
        Frontmatter becomes <code>meta</code>. The <code>props</code>{" "}
        block declares typed props. Text supports <code>{"{meta.key}"}</code>
        {" "}
        and <code>{"{props.key}"}</code> interpolation.
      </p>
      <CodeBlock filename="components/Greeting.md">{COMPONENT}</CodeBlock>

      <h2>Invoking a component</h2>
      <p>
        Capitalized JSX tags become component invocations. Names resolve from
        the component search directories (default <code>components</code> and
        {" "}
        <code>.</code>). Dotted names map to paths —{" "}
        <code>&lt;Tips.Formatting /&gt;</code> resolves to{" "}
        <code>Tips/Formatting.md</code>.
      </p>
      <CodeBlock>{'<Greeting name="world" />'}</CodeBlock>

      <h2>Slots &amp; children</h2>
      <p>
        <code>&lt;Content /&gt;</code>{" "}
        acts as a slot for the children passed to a component. Named slots
        (<code>slot="left"</code>) place children into specific regions.
      </p>
      <CodeBlock>{SLOT}</CodeBlock>

      <h2>Returning values</h2>
      <p>
        A component returns one thing. Without{" "}
        <code>returns</code>, that is its rendered Markdown — the component
        above renders text, and <code>as</code> binds that text as a string. A
        {" "}
        <code>returns</code>{" "}
        declaration makes it a value component instead: it renders nothing, must
        be invoked with{" "}
        <code>as</code>, and binds the JSON value its single top-level{" "}
        <code>&lt;Return /&gt;</code> produces, validated against the schema.
      </p>
      <CodeBlock filename="components/Review.md">{VALUE_COMPONENT}</CodeBlock>
      <p>The caller renders whatever presentation it wants from the value.</p>
      <CodeBlock>{VALUE_CAPTURE}</CodeBlock>
      <p>
        A root document uses the same two modes without the capture. Running a
        root that declares <code>returns</code>{" "}
        prints only its validated value as JSON; body output moves to stderr
        under <code>--verbose</code>.
      </p>
      <CodeBlock>{VALUE_ROOT}</CodeBlock>

      <h2>TypeScript components</h2>
      <p>
        A <code>.ts</code>{" "}
        file whose default export is a generator function is a component too. It
        receives validated props, declares them with a named <code>props</code>
        {" "}
        export, and reads its children with <code>useContent()</code>.
      </p>
      <CodeBlock filename="components/Section.ts">{TS_COMPONENT}</CodeBlock>
      <p>
        Resources it acquires belong to the invocation: they stay alive while
        the content it projects runs, and are released once that content has
        stopped — so a component can hold something open for its children
        without managing a scope itself. Durable effects it performs are
        journaled and replayed as usual.
      </p>

      <h3>Which form am I?</h3>
      <p>
        <code>hasContent()</code>{" "}
        answers from how the element was written, not from what it renders:{" "}
        <code>&lt;Thing&gt;…&lt;/Thing&gt;</code> and{" "}
        <code>&lt;Thing&gt;&lt;/Thing&gt;</code>{" "}
        both have content — content that renders an empty string is still
        content — and only <code>&lt;Thing /&gt;</code>{" "}
        does not. Asking never renders the children, so a component whose two
        forms mean different things can branch before projecting anything.
      </p>

      <h3>Outliving the invocation</h3>
      <p>
        Invocation lifetime is right for a wrapper, and wrong for a component
        that hands something back. A self-closing component returns a value the
        caller uses <em>after</em>{" "}
        the invocation is over — releasing the resource behind it at the
        boundary would return a name for something that no longer exists.
      </p>
      <p>
        <code>retain()</code>{" "}
        gives that resource invocation-site lifetime instead. Each call opens an
        isolated child of the invoking scope and runs the factory there, so the
        resource lives as long as that scope does — for the caller and its later
        siblings — while everything else the factory touches stays inside the
        child. Only the value it provides crosses back.
      </p>
      <CodeBlock filename="components/Thing.ts">{RETAIN_COMPONENT}</CodeBlock>
      <CodeBlock>{RETAIN_USAGE}</CodeBlock>
      <p>
        Retaining is a lifetime, not authority over the caller. A component
        cannot reach through <code>retain()</code>{" "}
        to set a context value or install middleware that its caller's later
        siblings would observe, and it never receives the invoking scope itself.
      </p>
      <p>
        Retaining also delays release rather than opting out of it. The
        invocation site is an ordinary scope, so when it finishes, fails, or is
        cancelled, everything retained into it is torn down, innermost first.
        Nothing escapes structured concurrency and nothing needs an explicit
        release.
      </p>
      <p>
        <code>retain()</code> belongs to TypeScript components. An{" "}
        <code>eval</code>{" "}
        block is durable — a replay restores its values without running it — so
        a resource retained from one would have nothing to re-establish it, and
        the call is refused rather than silently succeeding.
      </p>

      <h2>Scoped resources</h2>
      <p>
        <code>&lt;TempDir&gt;</code>{" "}
        is built into core — no search directory, no file to install. Written
        with content it gives that content an isolated working directory: nested
        components, code blocks, processes, and agents all observe it, without
        being handed a path.
      </p>
      <CodeBlock>{TEMPDIR}</CodeBlock>
      <p>
        Written self-closing there is nothing to wrap, so it renders the
        directory's path and keeps the directory alive for the siblings that
        follow. <code>as</code> captures that path like any other value.
      </p>
      <CodeBlock>{TEMPDIR_STANDALONE}</CodeBlock>
      <p>
        Either way cleanup is automatic and unconditional — on success, on
        failure, and on cancellation. There is no <code>retain</code>{" "}
        prop and nothing is kept after a failure. Because the directory is the
        invocation's own resource, anything the content started — a daemon, a
        watcher — is stopped before the directory is removed.
      </p>

      <p>
        One limitation, and it differs by form. Each run creates a new
        directory, while a recorded effect is matched by its description — so
        resuming from a partial journal would replay a result naming a directory
        that has been removed, and skip the filesystem work it stands for.
      </p>
      <p>
        Inside a <strong>wrapping</strong> <code>&lt;TempDir&gt;</code>{" "}
        that is caught: the effect fails, the whole execution fails with it, and
        nothing after the component runs. It is not a diagnostic the document
        can collect and continue past — re-run from the beginning.
      </p>
      <p>
        The <strong>standalone</strong>{" "}
        form has no such guard. A directory it retains belongs to the scope that
        invoked it, and a component cannot install anything there, so a later
        sibling replaying against a captured path is not detected — it continues
        with the recorded result, and nothing notices that the directory it came
        from is gone. Resuming a document that captures a temporary path is
        unsupported.
      </p>

      <h2>Parsing generated JSON</h2>
      <p>
        <code>&lt;Parse&gt;</code> and <code>&lt;SafeParse&gt;</code>{" "}
        are built into core as well. They turn content into a value the rest of
        the document can branch on, validated against a schema. Both take{" "}
        <code>schema</code> and{" "}
        <code>as</code>, render nothing, and parse whatever their children
        expand to — an agent's reply, a captured fence, a file's contents.
      </p>
      <p>
        <code>&lt;Parse&gt;</code>{" "}
        is the strict one: it binds the validated value, or fails.
      </p>
      <CodeBlock>{PARSE}</CodeBlock>
      <p>
        The schema is either captured JSON text, as above, or an already
        structured value — both compile the same way. It compiles{" "}
        <em>before</em>{" "}
        the children expand, so an unusable schema fails before the document
        spends a model call on content it could never judge.
      </p>
      <p>
        Neither component transforms what it validates. A declared{" "}
        <code>default</code>{" "}
        is not inserted, a type is not coerced, an undeclared property is not
        removed. What you bind is exactly what the content said. Parsing is also
        provider-neutral: no agent is involved, and no repair happens behind
        your back.
      </p>

      <h3>Inspecting a failure</h3>
      <p>
        <code>&lt;SafeParse&gt;</code>{" "}
        binds a result instead of failing. On success that is{" "}
        <code>{"{ ok: true, value }"}</code>; on failure,{" "}
        <code>{"{ ok: false, input, errors }"}</code>{" "}
        — the text that failed, kept exactly as it arrived, and what was wrong
        with it. Malformed JSON arrives as a single issue with{" "}
        <code>keyword: "parse"</code>, so both kinds of failure read the same
        way.
      </p>
      <CodeBlock>{SAFE_PARSE}</CodeBlock>
      <p>
        It absorbs JSON syntax and schema failures, and nothing else. An
        unusable schema still fails, and so does a failing child.
      </p>

      <h3>A bounded repair prompt</h3>
      <p>
        Because the failure is a value and <code>&lt;If&gt;</code>{" "}
        chooses a branch, the whole retry is ordinary Markdown rather than
        something hidden in the component. A successful result is read straight
        off <code>result.value</code>. A failed one quotes{" "}
        <code>result.input</code>, renders every issue in{" "}
        <code>result.errors</code>{" "}
        into one corrective prompt, and validates the reply strictly with{" "}
        <code>&lt;Parse&gt;</code>.
      </p>
      <CodeBlock>{REPAIR}</CodeBlock>
      <p>
        The retry is <strong>bounded by construction</strong>, not by a counter.
        {" "}
        <code>&lt;If&gt;</code>{" "}
        expands exactly one branch and never the other, so at most two attempts
        can execute: the initial{" "}
        <code>&lt;SafeParse&gt;</code>, and — only when that one failed — the
        single corrective <code>&lt;Parse&gt;</code> inside{" "}
        <code>&lt;Else&gt;</code>. When the first answer parses, the failure
        branch never expands, so its prompt is never sent. Nothing in the
        failure branch reaches back to the beginning, so there is no third
        attempt to bound.
      </p>

      <h2>How it renders</h2>
      <ul>
        <li>
          Component references are resolved from the filesystem and expanded
          recursively (with cycle detection).
        </li>
        <li>
          Markdown is healed at execution boundaries with{" "}
          <code>remend</code>, so formatting never bleeds across components.
        </li>
        <li>
          Because expansion is markdown-in / markdown-out, the document remains
          a clean file in any viewer.
        </li>
      </ul>

      <p style="margin-top:2rem;">
        Next: <a href="/docs/exec-eval">Exec &amp; Eval →</a>
      </p>
    </>
  );
});
