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

export default define.page(function ControlFlow() {
  return (
    <>
      <h1 style="font-size:2rem;font-weight:800;">Control flow</h1>
      <p class="muted">
        <code>&lt;If&gt;</code>{" "}
        chooses one branch of a document and expands only that branch. It is a
        directive the expansion engine handles directly, like{" "}
        <code>&lt;Each&gt;</code> and <code>&lt;Capture&gt;</code> — there is no
        {" "}
        <code>If.md</code> to import.
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
    </>
  );
});
