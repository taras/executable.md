import { define } from "../../utils.ts";
import { CodeBlock } from "../../components/Code.tsx";

const COMPONENT = `---
emoji: Hello
inputs:
  name:
    type: string
    required: true
---

{meta.emoji}, {props.name}!`;

const SLOT = `<Card title="Notes">
  Anything here becomes the card's children.
</Card>`;

export default define.page(function Components() {
  return (
    <>
      <h1 style="font-size:2rem;font-weight:800;">Components</h1>
      <p class="muted">
        A component is a markdown file with frontmatter and declared inputs,
        invoked with a JSX-style tag. Documents stay valid, readable markdown
        everywhere.
      </p>

      <h2>Defining a component</h2>
      <p>
        Frontmatter becomes <code>meta</code>. The <code>inputs</code>{" "}
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
