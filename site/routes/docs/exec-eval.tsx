import { define } from "../../utils.ts";
import { CodeBlock } from "../../components/Code.tsx";

const FENCE = String.fromCharCode(96).repeat(3);

const COMMAND = [
  "# Check the working tree",
  "",
  FENCE + "bash exec",
  "git status --short",
  FENCE,
].join("\n");

const VALUE = [
  FENCE + "ts eval",
  "const port = yield* findFreePort();",
  FENCE,
  "",
  "The local server uses port {port}.",
].join("\n");

const PROCESS = [
  FENCE + "ts eval",
  "const port = yield* findFreePort();",
  FENCE,
  "",
  FENCE + "bash daemon exec",
  "npm run dev -- --port {port}",
  FENCE,
  "",
  "The development server ran on port {port} while this document expanded.",
].join("\n");

const TIMEBOX = [
  FENCE + "bash silent timeout=30s exec",
  "git fetch --quiet",
  FENCE,
].join("\n");

export default define.page(function ExecEval() {
  return (
    <>
      <h1 style="font-size:2rem;font-weight:800;">Exec &amp; Eval</h1>
      <p class="muted">
        An executable document often needs one of three things: run a command
        and show its result, calculate a value for a later step, or keep a local
        process available while the document works. Choose the smallest tool
        that fits that need.
      </p>

      <h2>Run a command and keep its result in the document</h2>
      <p>
        Add <code>exec</code>{" "}
        after a fence language to run the block as a subprocess. Its standard
        output becomes part of the document, which is ideal for checks,
        inventories, and generated reports.
      </p>
      <CodeBlock filename="working-tree.md">{COMMAND}</CodeBlock>
      <p>
        Here, the rendered result contains the current Git status below the
        heading. Use a normal shell script instead when nobody needs the
        command, its result, or surrounding explanation in Markdown.
      </p>

      <h2>Derive a value for a later step</h2>
      <p>
        Use <code>eval</code>{" "}
        when later text or commands need a calculated value that a command alone
        does not provide. This example reserves a free local port, then
        interpolates it into the document. Evaluation is TypeScript or
        JavaScript that runs in the document process; use it only when an
        executable component cannot express the work declaratively.
      </p>
      <CodeBlock filename="local-port.md">{VALUE}</CodeBlock>
      <p>
        Top-level values from an <code>eval</code>{" "}
        block are available to later document text and executable blocks as{" "}
        <code>{"{name}"}</code>.
      </p>

      <h2>Keep a local process available for this workflow</h2>
      <p>
        Use <code>daemon exec</code>{" "}
        for a development server or other process that a later document step
        needs. The command returns control without rendering its output, and the
        process stops when the document finishes or fails.
      </p>
      <CodeBlock filename="run-local-server.md">{PROCESS}</CodeBlock>
      <p>
        Replace <code>npm run dev -- --port {"{port}"}</code>{" "}
        with your project&apos;s server command. The <code>findFreePort()</code>
        {" "}
        evaluation is necessary here because the process needs a real, available
        port.
      </p>

      <h2>Control execution when the common path is not enough</h2>
      <p>
        Add <code>silent</code>{" "}
        when a command prepares state but should not add output to the result.
        Add <code>timeout=30s</code>{" "}
        when a specific command needs a shorter bound than the shared timeout.
      </p>
      <CodeBlock>{TIMEBOX}</CodeBlock>
      <p>
        <code>persist eval</code>{" "}
        keeps resources created by an evaluation alive for the enclosing
        component. It is mainly useful when authoring components that manage a
        resource; ordinary documents normally use
        <code>daemon exec</code> for a local process instead.
      </p>

      <p style="margin-top:2rem;">
        Next: <a href="/docs/providers">LLM providers →</a>
      </p>
    </>
  );
});
