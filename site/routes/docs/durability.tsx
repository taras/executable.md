import { define } from "../../utils.ts";
import { CodeBlock } from "../../components/Code.tsx";

export default define.page(function Durability() {
  return (
    <>
      <h1 style="font-size:2rem;font-weight:800;">Durable replay</h1>
      <p class="muted">
        executable.md treats each document as a durable workflow. Every I/O
        operation is recorded in an append-only journal so execution survives
        crashes and replays from where it left off.
      </p>

      <h2>Running with a journal</h2>
      <CodeBlock>{"xmd run doc.md --journal .xmd/events.jsonl"}</CodeBlock>
      <p>On rerun with the same journal:</p>
      <ul>
        <li>component imports replay from stored content,</li>
        <li>
          completed <code>exec</code> and <code>eval</code>{" "}
          operations replay from stored results,
        </li>
        <li>replay guards can detect stale component inputs,</li>
        <li>execution resumes from the last successful durable step.</li>
      </ul>

      <h2>Write your logic once</h2>
      <p>
        Durability is built on{" "}
        <a href="https://frontside.com/effection" rel="noopener">Effection</a>
        {" "}
        via durable streams and durable effects. Your workflow logic is written
        once, with no replay-awareness code — no <code>if (replaying)</code>
        {" "}
        branches, no explicit checkpoint calls. If the process crashes between
        two steps, the workflow resumes exactly from that point; completed steps
        are not run again.
      </p>

      <h2>Portable journals</h2>
      <p>
        Journals store workspace-relative paths, so they remain portable across
        machines with the same repository structure. Commit a journal to share a
        reproducible run, or keep it local to resume long-running work.
      </p>

      <p style="margin-top:2rem;">
        Next: <a href="/docs/providers">LLM providers →</a>
      </p>
    </>
  );
});
