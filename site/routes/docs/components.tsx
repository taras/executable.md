import { define } from "../../utils.ts";
import { CodeBlock } from "../../components/Code.tsx";
import { NextCard } from "../../components/NextCard.tsx";

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

const TS_COMPONENT = `import { content } from "@executablemd/core";

export const props = {
  type: "object",
  properties: { title: { type: "string" } },
  required: ["title"],
  additionalProperties: false,
} as const;

export default function*(props) {
  const directory = yield* useTempDir();
  const body = yield* content();
  return \`## \${props.title}\\n\\n\${body}\`;
}`;

const RETAIN_COMPONENT =
  `import { content, hasContent, retain } from "@executablemd/core";

export default function*() {
  if (yield* hasContent()) {
    // A wrapper: the resource is alive exactly while the content expands.
    yield* useThing();
    return yield* content();
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

const FILE_READ = `<File path="request.md" />`;

const FILE_CAPTURE = `<File path="prompts/review.md" as="instructions" />

<Prompt>{instructions}</Prompt>`;

const WEBFORM = `\`\`\`js eval
const reviewSchema = {
  type: "object",
  properties: {
    decision: { type: "string", enum: ["approve", "reject"] },
    note: { type: "string" },
  },
  required: ["decision"],
  additionalProperties: false,
};
\`\`\`

<WebForm schema={reviewSchema} as="review">
# Review required

Read the plan above and decide.
</WebForm>

\`\`\`js eval
if (review.decision === "reject") {
  output(\`Stopping: \${review.note ?? "no reason given"}\`);
}
\`\`\``;

const WEBFORM_UI = `<WebForm
  schema={reviewSchema}
  uiSchema={{ note: { "ui:widget": "textarea" } }}
  as="review"
>
Read the plan above and decide.
</WebForm>`;

const ELICIT = `\`\`\`js eval
const responseSchema = {
  type: "object",
  properties: {
    decision: { type: "string", enum: ["approve", "reject"] },
    note: { type: "string" },
  },
  required: ["decision"],
};
\`\`\`

<Elicit schema={responseSchema} as="response">
Review the implementation plan and provide your decision.
</Elicit>

\`\`\`js eval
if (response.decision === "reject") {
  output(\`Stopping: \${response.note ?? "no reason given"}\`);
}
\`\`\``;

const ANSWERS = `<Answers>
<Answer template="Approve {?what}?" value={{ decision: "approve" }} />
<Answer value={{ decision: "reject", note: "unreviewed" }}>
Deploy {?service} to production?
</Answer>

<ReviewGate plan={plan} as="verdict" />
</Answers>`;

const ANSWERS_DELEGATE = `<Answers delegate={true}>
<Answer template="Approve {?what}?" value={{ decision: "approve" }} />

<ReviewGate plan={plan} as="first" />
<ReviewGate plan={other} as="second" />
</Answers>`;

const FILE_WRITE = `<TempDir>
<File path="fixtures/request.md">
Request content
</File>

\`\`\`sh exec
cat fixtures/request.md
\`\`\`
</TempDir>`;

const FILE_BOTH_FAIL =
  `cannot write "notes.md": the destination is on a different filesystem.
cannot clean up "notes.md": permission denied.
Whether the replacement committed is unknown: the target holds either the
complete previous content or the complete replacement, never a partial write.
A temporary file beside it may remain.`;

const FILE_INLINE = `<File path="a.txt">one line</File>`;

const FILE_BLOCK = `<File path="a.txt">
one line
</File>`;

const GLOB = `<Glob include={["**/AGENTS.md"]} as="instructionPaths" />`;

const GLOB_EXCLUDE = `<Glob
  include={["**/*.md"]}
  exclude={[".git/**", "**/node_modules/**"]}
  as="docs"
/>`;

const GLOB_PIPELINE = `<TempDir>
<File path="docs/guide.md">Guide</File>
<File path="docs/api/reference.md">Reference</File>
<File path="README.md">Readme</File>

<Glob include={["docs/**/*.md"]} as="docs" />

<Each in={docs} let="path">
<File path={path} />
</Each>
</TempDir>`;

const JSON_PROMPT = `<Let as="schema" value={{
  type: "object",
  required: ["bump"]
}} />

<Prompt>
Return JSON matching this schema:

<Json value={schema} />
</Prompt>`;

const JSON_FILE = `<File path="package.json"><Json value={manifest} />
</File>`;

const PARSE = `<Let as="schema" select="code[lang=json]">
\`\`\`json
{
  "type": "object",
  "properties": { "passed": { "type": "boolean" } },
  "required": ["passed"]
}
\`\`\`
</Let>

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
      <h1>Components</h1>
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
      <CodeBlock command>{VALUE_ROOT}</CodeBlock>

      <h2>TypeScript components</h2>
      <p>
        A <code>.ts</code>{" "}
        file whose default export is a generator function is a component too. It
        receives validated props, declares them with a named <code>props</code>
        {" "}
        export, and reads its content with <code>content()</code>.
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
        nothing after the component runs. It is not a printed error the document
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

      <h2>Reading and writing files</h2>
      <p>
        <code>&lt;File&gt;</code> is built into core too. It takes one prop — a
        {" "}
        <code>path</code>{" "}
        relative to the working directory — and does the obvious thing with it.
        Self-closing, it reads and renders the file's text.
      </p>
      <CodeBlock>{FILE_READ}</CodeBlock>
      <p>
        <code>as</code>{" "}
        captures that text and renders nothing, like any other component that
        returns text — which is how a prompt lives in a file instead of in the
        document.
      </p>
      <CodeBlock>{FILE_CAPTURE}</CodeBlock>
      <p>
        Written with content it writes instead, expanding its children first. It
        renders nothing at all: no output, no path, no file handle. Missing
        parent directories are created, and an existing file is replaced. Since
        the path is relative to the <em>contextual</em>{" "}
        working directory, it composes with <code>&lt;TempDir&gt;</code>{" "}
        without either component knowing about the other — the shell in the
        block below finds the file where <code>&lt;File&gt;</code> put it.
      </p>
      <CodeBlock>{FILE_WRITE}</CodeBlock>

      <h3>What gets written</h3>
      <p>
        Exactly what the children rendered. Nothing is added, trimmed,
        normalized, or reformatted — so where you put the tags is where the
        file's first and last bytes come from. On one line, that is the whole
        file:
      </p>
      <CodeBlock>{FILE_INLINE}</CodeBlock>
      <p>
        writes <code>one line</code>{" "}
        — no trailing newline. On its own line, the breaks around it are inside
        the element, so they are content too:
      </p>
      <CodeBlock>{FILE_BLOCK}</CodeBlock>
      <p>
        writes <code>{"\\none line\\n"}</code>{" "}
        . If you want a file to start or end a particular way, say so with where
        the tags go; the component never guesses. It is UTF-8 text only — no
        binary data, no configurable encodings, no append or patch modes.
      </p>

      <h3>Staying inside the workspace</h3>
      <p>
        Everything <code>&lt;File&gt;</code>{" "}
        touches stays inside the working directory, checked in two stages that
        run at different times.
      </p>
      <p>
        The first is pure path arithmetic: an absolute path and a{" "}
        <code>..</code>{" "}
        escape are refused with no filesystem call at all, so the failure says
        nothing about what the path named. Only a whole <code>..</code>{" "}
        segment escapes — <code>..notes.md</code>{" "}
        is just a file with an odd name. For a write this happens{" "}
        <em>before</em>{" "}
        the children expand, so an unusable path costs nothing and its message
        is about the path rather than about what the children then did.
      </p>
      <p>
        Path arithmetic alone would not be enough, because a symlink inside the
        directory can point anywhere. The second stage resolves whichever part
        of the path already exists and checks <em>that</em>{" "}
        — so a symlink staying inside is ordinary and gets followed to the file
        it names, and one that leaves is refused before anything outside is read
        or changed. For a write it runs <em>after</em>{" "}
        the children finish and immediately before writing, because a child can
        change what the path means — swapping a directory for a symlink out of
        the workspace, say. Resolving any earlier would approve one destination
        and write to another.
      </p>
      <p>
        The working directory is inside itself, so <code>.</code>{" "}
        is not an escape — it is a directory, and it fails as one.
      </p>

      <h3>The commit point</h3>
      <p>
        Children expand completely before anything is written, so a failing
        block leaves the existing file exactly as it was — and because the write
        has nowhere to render a printed error, it fails the invocation rather
        than writing the printed error into your file. The write itself lands
        through a rename, and that rename is the commit point:
      </p>
      <ul>
        <li>
          A failure or cancellation <em>before</em>{" "}
          the rename leaves the previous file untouched.
        </li>
        <li>
          Once the rename begins, what anyone sees is the complete old file or
          the complete new one — never a partial write.
        </li>
        <li>
          A commit is not a transaction. <code>rename</code>{" "}
          cannot be interrupted once it starts, and a cancellation arriving
          afterwards does not undo it.
        </li>
      </ul>
      <p>
        So the promise is that no write is ever half visible — not that a
        finished write can be taken back.
      </p>
      <p>
        Which means a failure can say three different things about your file,
        and only two of them are conclusions. If <code>rename</code>{" "}
        itself throws, the component genuinely cannot tell whether the commit
        happened: filesystem middleware may do work on either side of the call
        it wraps, so the throw may have arrived before the rename or after it
        succeeded. It says so rather than guessing.
      </p>
      <ul>
        <li>
          Preparation failed — <em>The previous file is unchanged.</em>
        </li>
        <li>
          The rename threw —{" "}
          <em>
            Whether the replacement committed is unknown: the target holds
            either the complete previous content or the complete replacement,
            never a partial write.
          </em>
        </li>
        <li>
          The rename returned — <em>The file was written.</em>
        </li>
      </ul>

      <h3>What a failure tells you</h3>
      <p>
        The message names the path you wrote and nothing else — not the resolved
        working directory, not where a symlink pointed, not the temporary file.
        Reporting where an escape led would perform the disclosure the refusal
        exists to prevent.
      </p>
      <p>
        That includes errors from the filesystem itself, which name the path
        they failed on. Every call is wrapped, and nothing from the error is
        reproduced: its code <em>selects</em> a phrase from a fixed list —{" "}
        <em>
          a component of the path is not a directory
        </em>{" "}
        — and an unrecognized code selects{" "}
        <em>the filesystem operation failed</em>. The code is never printed,
        because whatever implements the filesystem can put a path or a newline
        in it as easily as <code>ENOENT</code>.
      </p>
      <p>
        If removing the temporary fails, you are told — a file you did not
        create may be sitting next to one you did. That report names the path
        you wrote, never the generated temporary, and it never replaces a write
        failure it accompanies. When both fail you get both, plus a sentence
        saying what the directory now holds:
      </p>
      <CodeBlock>{FILE_BOTH_FAIL}</CodeBlock>

      <h3>What this is not</h3>
      <p>
        Containment is judged against the filesystem as{" "}
        <code>&lt;File&gt;</code>{" "}
        observes it, which holds while the filesystem is stable. It is not a
        sandbox: another process can replace a directory with a symlink between
        the moment a path is checked and the moment it is used. Resolving a
        write's destination immediately before writing closes that window for
        the case your document controls — its own children — but check-then-use
        does not become atomic by being ordered more carefully. Containment that
        does not depend on observed state is tracked in issue #227.
      </p>

      <h2>Finding files</h2>
      <p>
        <code>&lt;Glob&gt;</code>{" "}
        answers the other half of the question: not "read this file" but "which
        files are there". It takes <code>include</code>{" "}
        — at least one glob pattern — and binds the paths it found. It declares
        a return value, so it renders nothing and <code>as</code> is required.
      </p>
      <CodeBlock>{GLOB}</CodeBlock>
      <p>
        <code>exclude</code> is optional and wins over include.
      </p>
      <CodeBlock>{GLOB_EXCLUDE}</CodeBlock>
      <p>
        It is decided per file, against that file's own path — so a pattern
        matching a <em>directory</em>{" "}
        removes nothing by itself, because directories are not results.{" "}
        <code>vendor</code> removes nothing at all; <code>vendor/*</code>{" "}
        removes what is directly inside and keeps{" "}
        <code>vendor/deep/keep.md</code>, since <code>*</code>{" "}
        never crosses a separator; <code>vendor/**</code>{" "}
        removes the whole subtree.
      </p>
      <p>
        Only that last form lets the directory be <em>skipped</em>{" "}
        rather than walked, which is why <code>.git/**</code> and{" "}
        <code>**/node_modules/**</code>{" "}
        cost nothing on a real repository. Every other exclusion walks the
        subtree and filters its files one at a time — pruning is an
        optimization, and it never changes the answer.
      </p>
      <p>
        Patterns are relative to the same contextual working directory{" "}
        <code>&lt;File&gt;</code>{" "}
        uses, and so are the results — which is what lets the three components
        become a pipeline. Build a fixture, discover it, read every match, all
        without a path that means something only on your machine:
      </p>
      <CodeBlock>{GLOB_PIPELINE}</CodeBlock>

      <h3>What you get back</h3>
      <p>
        A <em>set</em>{" "}
        of relative paths, and each word there is doing work. Paths use{" "}
        <code>/</code>{" "}
        on every platform. A file that several patterns match is one result. And
        they are sorted by code point — not by locale, whose answer depends on
        how the host is configured, and not in the order the filesystem handed
        entries back, which is not an order at all. A document that branches on
        a listing branches the same way everywhere.
      </p>
      <p>
        Finding nothing is a{" "}
        <em>result</em>: an empty array, and the document carries on.
      </p>
      <p>
        A leading dot is an ordinary character, so there is no hidden-file
        option. <code>*</code> matches one like anything else —{" "}
        <code>*.md</code> finds <code>.hidden.md</code>{" "}
        — and a pattern finds a hidden file exactly when it says so.
      </p>
      <p>
        Only files come back. Directories are not results, and neither are
        symbolic links: a link is a link, not a file. A link to a directory is
        not descended into either, which is what keeps a search inside the
        working directory without having to judge where anything points —
        traversal follows only real directories, so it cannot leave and cannot
        cycle.
      </p>

      <h3>When a pattern is wrong</h3>
      <p>
        A pattern that cannot match anything a relative search produces — an
        absolute one, one starting with <code>..</code>{" "}
        , or an empty string — fails rather than quietly contributing nothing.
        An empty result has to keep meaning{" "}
        <em>there are no such files</em>, so a typo must not also produce one.
        Only a whole leading <code>..</code> segment counts;{" "}
        <code>..notes.md</code> is just a file with an odd name.
      </p>
      <p>
        A missing working directory, one that turns out to be a file, and a
        directory that cannot be read all fail too. That last message names no
        path at all — what failed is a directory under the working directory
        that you never wrote — and as with{" "}
        <code>&lt;File&gt;</code>, nothing from the underlying error is
        reproduced: its code selects a phrase from a fixed list.
      </p>

      <h2>Rendering a value as JSON</h2>
      <p>
        <code>&lt;Json&gt;</code>{" "}
        turns a value the document already holds into JSON text, right where you
        write it. <code>&lt;Let&gt;</code> introduces the value,{" "}
        <code>&lt;Json&gt;</code> renders it, and <code>&lt;Parse&gt;</code>
        {" "}
        below turns text back into a value — three visible steps rather than a
        <code>JSON.stringify</code> hidden in an eval block.
      </p>
      <CodeBlock>{JSON_PROMPT}</CodeBlock>
      <p>
        The formatting is fixed: two spaces per level, keys in the order the
        object has them, and nothing else to choose. There is no{" "}
        <code>indent</code>, <code>pretty</code>{" "}
        or replacer option, and it binds nothing — <code>as</code>{" "}
        is refused, because this renders text.
      </p>
      <p>
        It also adds{" "}
        <strong>no trailing newline</strong>. Text lands exactly where the
        element sits, so a file that has to end in a newline gets one from the
        document that writes it:
      </p>
      <CodeBlock>{JSON_FILE}</CodeBlock>
      <p>
        Ordinary <code>{"{binding}"}</code>{" "}
        interpolation is unchanged — it still coerces a value to a string the
        way it always has. Nothing converts to JSON behind your back; you ask
        for it by name.
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

      <h2>Asking a person</h2>
      <p>
        <code>&lt;WebForm&gt;</code>{" "}
        stops the workflow and asks someone a question. It opens a form in the
        browser, waits for one answer, binds it, and carries on — so a document
        can put a human decision in the middle of an otherwise automatic run.
      </p>
      <CodeBlock>{WEBFORM}</CodeBlock>
      <p>
        The form is generated from{" "}
        <code>schema</code>, a draft-07 JSON Schema, and the children become the
        page's own content above it. The component renders nothing: what it
        produces is the validated answer, so <code>as</code> is required.
      </p>
      <p>
        <code>uiSchema</code>{" "}
        is optional and controls presentation only — it is RJSF configuration
        rather than a schema, and is never validated as one.
      </p>
      <CodeBlock>{WEBFORM_UI}</CodeBlock>
      <p>
        The server runs on <code>127.0.0.1</code>{" "}
        behind a single-use, unguessable URL, which is printed as well as opened
        — so a workflow over SSH, or on a machine with no browser, still gives
        you a link that works. The page is entirely self-contained: it makes no
        request off the machine, and the answer is validated again on the server
        before the document ever sees it.
      </p>
      <p>
        Only the answer is journaled. Resuming a document that already has one
        binds the recorded value without starting a server or asking anyone
        twice.
      </p>

      <h2>Asking without choosing how</h2>
      <p>
        <code>&lt;WebForm&gt;</code>{" "}
        is a browser form by construction — a document that writes it has picked
        a transport. <code>&lt;Elicit&gt;</code>{" "}
        asks the same kind of question without saying where the asking happens.
      </p>
      <CodeBlock>{ELICIT}</CodeBlock>
      <p>
        <code>schema</code> and <code>as</code>{" "}
        are required, and that is the whole surface. There is no{" "}
        <code>mode</code> or <code>provider</code> prop, no{" "}
        <code>uiSchema</code>, and no built-in approve, decline, or cancel: the
        schema defines every response available. Where the question is actually
        put to someone is the host's decision, installed through the Elicitation
        Api — a browser form under the CLI today, a terminal or an editor
        integration later, or answers the document supplies itself. Swapping one
        for another changes no Markdown.
      </p>
      <p>
        That is the reason it is contextual rather than an author-facing option.
        A <code>mode</code>{" "}
        prop would make every document that used it a document about its own
        transport, and a workflow written for a browser could not then run
        anywhere else.
      </p>
      <p>
        The order is fixed and observable: the schema compiles first, so an
        unusable one fails before anything is asked; the content expands into
        the request; and the answer is validated against the same schema before
        it binds. An answer that fails it fails once — correction belongs inside
        the provider, and retry belongs in visible <code>&lt;If&gt;</code>{" "}
        control flow rather than in a hidden loop. Resuming restores the
        recorded answer without asking again.
      </p>
      <p>
        Reach for <code>&lt;WebForm&gt;</code>{" "}
        when the browser form itself is the point and you want RJSF presentation
        control; reach for <code>&lt;Elicit&gt;</code>{" "}
        when what matters is the question.
      </p>

      <h2>Answering from the document</h2>
      <p>
        A component that elicits internally asks whoever the host's provider
        reaches. Sometimes the document already knows the answer — exercising
        somebody else's component non-interactively, a demo, a stretch of a
        longer run that should not stop for a person.{" "}
        <code>&lt;Answers&gt;</code> is how a document says so.
      </p>
      <CodeBlock>{ANSWERS}</CodeBlock>
      <p>
        Each <code>&lt;Answer&gt;</code>{" "}
        is a matcher. Its template is compared against the whole message the
        elicitation asked: literal text constrains, <code>{"{?name}"}</code>
        {" "}
        matches any text and binds nothing, and <code>{"{binding}"}</code>{" "}
        requires an existing value at that spot. A matcher with no template
        matches anything. Write the template as a prop for one line, or as
        children when the question runs long.
      </p>
      <p>
        Selection is two rules and nothing else: the{" "}
        <strong>first declared</strong>{" "}
        matching answer wins, and a matcher is not used up by answering — it
        keeps answering everything it matches. Which means declaration order is
        real: a broad template above a narrow one shadows it for good.
      </p>
      <p>
        For as long as its body lasts, the region is the provider. Everything
        else is unchanged — each answer is still checked against the schema of
        whatever asked for it, so a value that does not fit fails exactly as a
        person's answer would.
      </p>
      <p>
        An elicitation no matcher answers is an error by default, and the
        printed error names both the message and every template that was tried.
        A document supplying answers is saying what will be asked, and being
        wrong about that is a mistake rather than a reason to go find someone.
        {" "}
        <code>delegate</code>{" "}
        says the other thing on purpose: whatever this region cannot answer
        passes outward, to an enclosing region or to whatever the host
        installed.
      </p>
      <CodeBlock>{ANSWERS_DELEGATE}</CodeBlock>
      <p>
        Regions nest, and the nearest one answers — ordinary middleware nesting.
        A matcher that never fires is not a mistake; a branch that did not run
        is still a branch you were right to describe. Resuming matches nothing,
        so a region needs only what the run will actually ask.
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

      <NextCard href="/docs/exec-eval" label="Exec & Eval" />
    </>
  );
});
