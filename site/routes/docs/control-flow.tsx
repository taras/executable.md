import { define } from "../../utils.ts";
import { CodeBlock } from "../../components/Code.tsx";

const SIMPLE = `<If condition={hasFailures}>
## Test failures

<FailureReport />
<Else>
All checks passed.
</Else>
</If>`;

const NO_ELSE = `<If condition={releaseChanged}>
> [!WARNING]
> Release configuration changed — update the release spec.
</If>`;

const TRAILING = `<If condition={hasFailures}>
Failures found.
<Else>
All checks passed.
</Else>
This line is an error — it belongs to neither branch.
</If>`;

const NESTED = `<Review as="review" />

<If condition={review.passed}>
Review passed: {review.summary}
<Else>
<If condition={review.blocking}>
Blocked: {review.summary}
<Else>
Needs revision: {review.summary}
</Else>
</If>
</Else>
</If>`;

const BINDING = `<If condition={verdict.passed}>
<Capture as="headline">All {verdict.total} checks passed.</Capture>
<Else>
<Capture as="headline">{verdict.failed} of {verdict.total} checks failed.</Capture>
</Else>
</If>

<GitHubComment body={headline} />`;

const FIXED_LOOP = `<Loop max={3}>
<Probe as="reading" />

Reading {reading.label}: {reading.value}
</Loop>`;

const REVIEW_LOOP = `<Loop name="planning" max={5}>
<Plan />
<Review as="verdict" />
<If condition={verdict.passed}>
<Break />
</If>
</Loop>

<If condition={verdict.passed}>
Plan approved: {verdict.summary}
<Else>
Five revisions were not enough — escalating.
</Else>
</If>`;

const LOOP_BINDING = `<Capture as="log">attempts:</Capture>

<Loop max={3}>
<Attempt as="attempt" />
<Capture as="log">{log} {attempt.status}</Capture>
</Loop>

<GitHubComment body={log} />`;

export default define.page(function ControlFlow() {
  return (
    <>
      <h1 style="font-size:2rem;font-weight:800;">Control flow</h1>
      <p class="muted">
        <code>&lt;If&gt;</code> chooses one branch of a document, and{" "}
        <code>&lt;Loop&gt;</code>{" "}
        repeats a region a bounded number of times. Both are directives the
        expansion engine handles directly, like <code>&lt;Each&gt;</code> and
        {" "}
        <code>&lt;Capture&gt;</code> — there is no <code>If.md</code> or{" "}
        <code>Loop.md</code> to import.
      </p>

      <h2>Choosing a branch</h2>
      <p>
        <code>condition</code>{" "}
        is the only prop, and it must be a boolean — there is no truthy or falsy
        coercion, so a string, number, array, or <code>null</code>{" "}
        is an error rather than a branch. The optional <code>&lt;Else&gt;</code>
        {" "}
        block holds the alternative and is written once, as a direct child.
      </p>
      <CodeBlock>{SIMPLE}</CodeBlock>

      <p>
        Without <code>&lt;Else&gt;</code>, a false condition renders nothing.
      </p>
      <CodeBlock>{NO_ELSE}</CodeBlock>

      <p>
        An <code>&lt;If&gt;</code> has exactly two branches, so{" "}
        <code>&lt;Else&gt;</code>{" "}
        is its final substantive child. Blank lines between{" "}
        <code>&lt;/Else&gt;</code> and <code>&lt;/If&gt;</code>{" "}
        are formatting and are ignored, but any content there belongs to neither
        branch and is an error rather than a third region quietly attached to
        the true branch.
      </p>
      <CodeBlock>{TRAILING}</CodeBlock>

      <h2>Only the selected branch expands</h2>
      <p>
        The branch that is not selected is not hidden output — it never expands.
        Nothing in it imports a component, runs an <code>exec</code> or{" "}
        <code>eval</code>{" "}
        block, reaches an LLM provider, touches the filesystem, creates a
        binding, or writes a journal entry. Putting expensive work in a branch
        costs nothing when the condition does not select it.
      </p>

      <h2>Nesting</h2>
      <p>
        Nested <code>&lt;If&gt;</code>{" "}
        blocks select independently, and each one owns the{" "}
        <code>&lt;Else&gt;</code> beneath it.
      </p>
      <CodeBlock>{NESTED}</CodeBlock>

      <h2>Bindings survive the branch</h2>
      <p>
        <code>&lt;If&gt;</code>{" "}
        creates no binding scope. A capture the selected branch makes behaves
        like inline content and stays available after{" "}
        <code>&lt;/If&gt;</code>, so both branches can bind the same name and
        later content reads it without knowing which one ran. The unselected
        branch binds nothing at all.
      </p>
      <CodeBlock>{BINDING}</CodeBlock>

      <h2>Repeating with Loop</h2>
      <p>
        <code>&lt;Loop&gt;</code>{" "}
        expands a region more than once, under a bound the document states.{" "}
        <code>max</code>{" "}
        is required and must be a positive integer — there is no unbounded form.
      </p>
      <CodeBlock>{FIXED_LOOP}</CodeBlock>

      <h2>Bindings carry across iterations</h2>
      <p>
        <code>&lt;Loop&gt;</code>{" "}
        creates no binding scope. Each iteration expands in the enclosing
        environment, so it reads what earlier iterations bound, and the final
        values stay available after <code>&lt;/Loop&gt;</code>{" "}
        — that is how a document acts on what the repetition produced. This is
        the opposite of{" "}
        <code>&lt;Each&gt;</code>, whose per-item binding lives only for the
        iteration that renders it.
      </p>
      <CodeBlock>{LOOP_BINDING}</CodeBlock>

      <h2>Leaving early with Break</h2>
      <p>
        <code>&lt;Break /&gt;</code>{" "}
        ends the loop it is written in. It stops the rest of the current
        iteration — content after it does not expand, so it imports no
        component, runs no block, and reaches no provider — and skips the
        iterations that were left. A nested <code>&lt;Loop&gt;</code>{" "}
        handles its own break, and a component invoked from a loop body cannot
        break the loop that invoked it.
      </p>
      <CodeBlock>{REVIEW_LOOP}</CodeBlock>

      <h2>Exhaustion is not failure</h2>
      <p>
        Reaching <code>max</code>{" "}
        completes the loop normally and produces no diagnostic. Whether five
        rejected plans mean the work failed is a decision only the surrounding
        document can make, so you write it as an <code>&lt;If&gt;</code>{" "}
        on whatever the body bound — as the review loop above does. A retry
        limit is explicit document policy, never something{" "}
        <code>&lt;Loop&gt;</code> decides on your behalf.
      </p>
      <p>
        The loop keeps no counter you can read. Iterations do have a
        deterministic identity — it is what lets a run replay into the same
        iteration it was interrupted in — but that identity is internal, not a
        binding the body can branch on.
      </p>
    </>
  );
});
