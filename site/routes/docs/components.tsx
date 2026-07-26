import { define } from "../../utils.ts";
import { CodeBlock } from "../../components/Code.tsx";

const FENCE = String.fromCharCode(96).repeat(3);

const CHECK = [
  "---",
  "inputs:",
  "  type: object",
  "  properties:",
  "    title:",
  "      type: string",
  "    command:",
  "      type: string",
  "  required: [title, command]",
  "  additionalProperties: false",
  "---",
  "",
  "## {props.title}",
  "",
  FENCE + "bash exec",
  "{props.command}",
  FENCE,
  "",
  "<Content />",
].join("\n");

const REPORT = [
  "# Release readiness",
  "",
  '<Check title="Typecheck" command="deno task check">',
  "Run this before publishing a package.",
  "</Check>",
  "",
  '<Check title="Tests" command="deno task test">',
  "Investigate failures before continuing.",
  "</Check>",
].join("\n");

export default define.page(function Components() {
  return (
    <>
      <h1 style="font-size:2rem;font-weight:800;">Components</h1>
      <p class="muted">
        Use a component when a useful part of a workflow repeats: a check with a
        heading, a command, and an explanation; a standard report section; or a
        team-approved maintenance step. It lets documents say what they need
        without copying the pattern each time.
      </p>

      <h2>Turn a repeated check into a reusable pattern</h2>
      <p>
        This <code>Check</code>{" "}
        component accepts the two choices each use needs: a title for the reader
        and the command to run. Its <code>&lt;Content /&gt;</code>{" "}
        location keeps any call-specific guidance beside the result.
      </p>
      <CodeBlock filename="components/Check.md">{CHECK}</CodeBlock>
      <p>
        A release-readiness report can now reuse that pattern while keeping its
        own instructions close to each check:
      </p>
      <CodeBlock filename="release-readiness.md">{REPORT}</CodeBlock>
      <p>
        Run{" "}
        <code>xmd run release-readiness.md</code>. Each invocation expands the
        component, runs its command, and places both the explanation and command
        output in the report.
      </p>

      <h2>Choose what callers may change</h2>
      <p>
        The <code>inputs</code>{" "}
        section declares the values a component accepts. It validates that
        callers provide a string <code>title</code>
        and <code>command</code>, then makes them available as{" "}
        <code>{"{props.title}"}</code> and{" "}
        <code>{"{props.command}"}</code>. Put fixed component metadata in
        frontmatter and refer to it with <code>{"{meta.name}"}</code>.
      </p>

      <h2>Compose a workflow without hiding its intent</h2>
      <p>
        Capitalized tags name components. By default,{" "}
        <code>&lt;Check /&gt;</code> finds{" "}
        <code>components/Check.md</code>; add other search locations with{" "}
        <code>--component-dir</code>. A dotted name such as{" "}
        <code>&lt;Tips.Formatting /&gt;</code> finds{" "}
        <code>Tips/Formatting.md</code>.
      </p>
      <p>
        Children appear only where a component includes{" "}
        <code>&lt;Content /&gt;</code>. Named <code>slot</code>{" "}
        values let a component place different caller regions deliberately. Use
        them for a layout that genuinely needs separate regions; one content
        location is clearer for most checks.
      </p>

      <p style="margin-top:2rem;">
        Next: <a href="/docs/exec-eval">Exec &amp; Eval →</a>
      </p>
    </>
  );
});
