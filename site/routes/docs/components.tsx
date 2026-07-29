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

<Show when={review.passed}>
Review passed: {review.summary}
</Show>`;

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

const RETAIN_COMPONENT = `import { hasContent, retain, useContent } from "@executablemd/core";

export default function*() {
  if (yield* hasContent()) {
    // A wrapper: whatever it holds is as long-lived as the content.
    return yield* useContent();
  }
  // Standalone: the caller uses this after the invocation is over.
  return yield* retain(useToken);
}`;

const RETAIN_USAGE = `<Probe as="token" />

The token {token} is still live here.`;

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
        answers from how the element was written, not from what it renders:
        {" "}
        <code>&lt;Probe&gt;…&lt;/Probe&gt;</code> and{" "}
        <code>&lt;Probe&gt;&lt;/Probe&gt;</code> both have content — content
        that renders an empty string is still content — and only{" "}
        <code>&lt;Probe /&gt;</code>{" "}
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
        gives that resource invocation-site lifetime instead. The factory runs
        in the scope that invoked the component, so what it acquires belongs to
        that scope from the beginning: it stays alive for the caller and its
        later siblings.
      </p>
      <CodeBlock filename="components/Probe.ts">{RETAIN_COMPONENT}</CodeBlock>
      <CodeBlock>{RETAIN_USAGE}</CodeBlock>
      <p>
        Retaining delays release; it does not opt out of it. The invocation
        site is an ordinary scope, so when it finishes, fails, or is cancelled,
        everything retained into it is torn down, innermost first. Nothing
        escapes structured concurrency and nothing needs an explicit release.
      </p>
      <p>
        <code>retain()</code> belongs to TypeScript components. An{" "}
        <code>eval</code>{" "}
        block is durable — a replay restores its values without running it — so
        a resource retained from one would have nothing to re-establish it, and
        the call is refused rather than silently succeeding.
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
