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

const RECORDS = `loop_iteration  loop:4:iteration:0   { "iteration": 0 }
loop_iteration  loop:4:iteration:1   { "iteration": 1 }
loop_iteration  loop:4:iteration:2   { "iteration": 2 }
loop            loop:4               { "iterations": 3, "outcome": "break" }`;

const INTERRUPTED =
  `Completed    terminal entry, exhausted or break   root close ok
Failed       terminal entry, error                root close err
Interrupted  iteration entries only               no root close`;

const PROJECTED_BREAK = `<Loop max={3}>
<Panel title="Attempt">
<Attempt as="attempt" />
<If condition={attempt.ok}>
<Break />
</If>
</Panel>
</Loop>`;

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
        handles its own break.
      </p>
      <CodeBlock>{REVIEW_LOOP}</CodeBlock>
      <p>
        Which loop a <code>&lt;Break /&gt;</code>{" "}
        means is decided by where you wrote it. Content you hand to a component
        is still your text, so a break in it ends your loop — the component
        finishes rendering, and the break lands when the invocation returns. A
        {" "}
        <code>&lt;Break /&gt;</code>{" "}
        a component writes in its own body belongs to a loop in that body, never
        to the loop that invoked the component.
      </p>
      <CodeBlock>{PROJECTED_BREAK}</CodeBlock>
      <p>
        A malformed <code>&lt;Break /&gt;</code>{" "}
        — one carrying props or content — does no control action at all. It is
        not an instruction the loop can act on, so it reports and the loop keeps
        its own course.
      </p>

      <h2>Exhaustion is not failure</h2>
      <p>
        Reaching <code>max</code>{" "}
        completes the loop normally and produces no printed error. Whether five
        rejected plans mean the work failed is a decision only the surrounding
        document can make, so you write it as an <code>&lt;If&gt;</code>{" "}
        on whatever the body bound — as the review loop above does. A retry
        limit is explicit document policy, never something{" "}
        <code>&lt;Loop&gt;</code> decides on your behalf.
      </p>
      <h2>What the journal records</h2>
      <p>
        A loop writes its own entries rather than leaving you to reconstruct
        what it did from whatever the body happened to record. Each iteration
        gets an entry <em>before</em>{" "}
        it runs, carrying its zero-based identity — so the entry means the
        iteration was entered, not that its body finished, and an empty
        iteration is on the record exactly like a busy one. When the loop
        finishes it writes one terminal entry saying how:{" "}
        <code>exhausted</code>, <code>break</code>, or <code>error</code>{" "}
        — with the number of iterations entered.
      </p>
      <CodeBlock>{RECORDS}</CodeBlock>
      <p>
        That is what separates a loop that broke on its final iteration from one
        that exhausted the same bound: identical iteration entries, different
        terminal outcome. The identity is internal — the loop keeps no counter
        your document can read. It exists so a run can resume into the iteration
        it stopped in, not so the body can branch on it.
      </p>
      <p>
        When a run resumes, the terminal entry is <strong>validated</strong>
        {" "}
        rather than trusted. An iteration entry names its own number, so
        replaying it already checks it; a terminal entry names only the loop, so
        a recorded <code>exhausted</code>{" "}
        would otherwise stand in for a resumed run that actually broke. If the
        stored outcome or count disagrees with what the resumed run reached, the
        run stops with a stale-input error instead of continuing under an
        outcome it never reached.
      </p>
      <p>
        And a durability failure is never recorded as a loop outcome. If the
        journal is already wrong about this run — a resource it recorded is
        gone, or the replay diverged — the loop writes nothing, and the failure
        you get back is that failure itself, at the operation that hit it,
        rather than a later mismatch somewhere downstream. Only an ordinary
        document failure produces the <code>error</code> outcome.
      </p>
      <p>
        A stale-record printed error names the loop and the outcome the run
        derived. It never quotes what the journal held: that is external data,
        and a printed error that reproduced it would carry whatever it contained
        into your logs and output.
      </p>

      <h2>Interrupted runs</h2>
      <p>
        A terminal entry means the loop finished. A loop that is{" "}
        <strong>interrupted</strong>{" "}
        — the run was cancelled, or the process died — has iteration entries and
        no terminal entry. Nothing is written on the way down on purpose: an
        entry appended during teardown would land after the iteration entries a
        resumed run still has to replay, and would break the resume.
      </p>
      <p>
        The same holds one level up. A run that finishes ends with a root close:
        {" "}
        <code>ok</code> on success, <code>err</code>{" "}
        for a document failure, which a loop's <code>error</code>{" "}
        outcome precedes. An interrupted run has no root close at all.
      </p>
      <CodeBlock>{INTERRUPTED}</CodeBlock>
      <p>
        So the journal tells you whether a run finished, and deliberately does
        not tell you why an unfinished one stopped — a cancellation and a crash
        leave the same durable state. They mean the same thing to a reader and
        take the same recovery path: hand the journal to a new run, which
        replays what completed and executes the rest live. Which one happened is
        runtime knowledge, not journal state.
      </p>
    </>
  );
});
