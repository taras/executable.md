/**
 * `<Git.Commit>` — record exactly what is staged, and hand back its SHA
 * (specs/workflow-workspace-spec.md §7.3).
 *
 * ```md
 * <Repository name="project" url={props.repository}>
 *   <Git.Commit message={summary} as="commit">
 *     <Git.Add paths="release/notes.md" />
 *
 * Generated from validated release metadata.
 *   </Git.Commit>
 * </Repository>
 * ```
 *
 * Content expands first, completely, before this element describes an effect of
 * its own. That is what makes a nested `<Git.Add>` mean what a document written
 * that way reads as: the staging is its own expansion, its own effect and its
 * own transaction, finished before a commit exists to include it.
 *
 * The message is composed from what a document wrote and then canonicalized
 * once. `message` alone is the whole message; content alone is the whole
 * message; both put the prop first and the rendered text one blank line after
 * it. Line endings become LF, whitespace at the very end is removed, and exactly
 * one final newline is added — leading and interior text are untouched, because
 * a commit message is authored prose and rewriting the middle of one would
 * commit something nobody wrote. What is left is what Git receives verbatim,
 * and the digest and byte length the run retains describe those exact bytes.
 *
 * It commits the index and nothing else. There is no path, no implicit staging,
 * no amend, no empty commit and no signing — each is a different operation, and
 * a document that wants one says so with the component that owns it.
 *
 * Unlike the other two Git operations this one produces a value, so it renders
 * nothing and is written with `as`: the binding is the full object id of the
 * commit, which is the one fact a later element can act on.
 */

import { cwd } from "@executablemd/runtime";
import { content, hasContent } from "@executablemd/core";
import type { PropsSchema, ReturnsSchema } from "@executablemd/core";
import type { Operation } from "effection";
import type { Json } from "@executablemd/durable-streams";
import { GitComposition } from "../git-api.ts";
import { currentRepository } from "../context.ts";
import { GitOperationAuthorityError, GitOperationError } from "../errors.ts";
import { wellFormedText } from "../parse.ts";
import { parseGitCommitMessageSource } from "../git-records.ts";
import type { GitCommitMessageSource } from "../git-records.ts";

/** The component name, as a document writes it and as a failure names it. */
export const COMMIT = "<Git.Commit>";

export const props: PropsSchema = {
  type: "object",
  properties: { message: { type: "string", minLength: 1 } },
  additionalProperties: false,
};

/** A full object id, in either algorithm a repository names its objects with. */
export const returns: ReturnsSchema = {
  type: "string",
  pattern: "^([0-9a-f]{40}|[0-9a-f]{64})$",
};

/** The canonical form of a message with no text in it. */
const BLANK = "\n";

function invalid(sentence: string): never {
  throw new GitOperationError(COMMIT, "invalid-invocation", `${COMMIT} ${sentence}`);
}

/**
 * The bytes a composed message becomes, canonically.
 *
 * Three transformations and no others. Line endings are LF, so a message
 * assembled on one host is the same message on another; whitespace at the very
 * end is removed, so trailing blank lines a renderer left behind are not part of
 * what is committed; and exactly one final newline is added, which is how Git
 * itself writes a message. Everything before that end — leading blank lines,
 * interior spacing, blank lines between paragraphs — survives, because a message
 * is authored text and this is not the place to edit one.
 */
export function canonicalCommitMessage(source: string): string {
  const lines = lineFeeds(source);
  let end = lines.length;
  while (end > 0 && WHITESPACE.test(lines.charAt(end - 1))) {
    end -= 1;
  }
  return `${lines.slice(0, end)}\n`;
}

const WHITESPACE = /\s/;

function lineFeeds(source: string): string {
  return source.replace(/\r\n?/g, "\n");
}

/**
 * Rendered content, with the blank lines a renderer put in front of it gone.
 *
 * Where content begins in a document is layout, not text: `<Git.Commit>` on one
 * line and its prose on the next renders a leading newline that nobody wrote.
 * A commit message whose first line is empty has no subject, so those lines are
 * not part of what a document said. Indentation on the first line that does hold
 * text survives, and so does everything after it.
 */
function contentText(body: string): string {
  const lines = lineFeeds(body);
  let start = 0;
  for (;;) {
    let scan = start;
    while (lines.charAt(scan) === " " || lines.charAt(scan) === "\t") {
      scan += 1;
    }
    if (lines.charAt(scan) !== "\n") {
      return lines.slice(start);
    }
    start = scan + 1;
  }
}

/** A composed message and where its text came from. */
export interface ComposedCommitMessage {
  readonly message: string;
  readonly source: GitCommitMessageSource;
}

/**
 * The message this invocation names, and which of its two sources it came from.
 *
 * Content that renders nothing is content that says nothing: a `<Git.Add>` child
 * renders the empty string, so an element written with staging inside it and a
 * message beside it is a `prop` message rather than a `both` message with an
 * empty half. Whether text was contributed is decided by canonicalizing it, so
 * a renderer's trailing newline does not count as a paragraph.
 */
export function composeCommitMessage(
  message: string | undefined,
  body: string,
): ComposedCommitMessage {
  const text = contentText(body);
  const contributes = canonicalCommitMessage(text) !== BLANK;
  if (message === undefined) {
    if (!contributes) {
      invalid(
        "needs a message. Write one as a message prop, as content that renders text, or as both.",
      );
    }
    return composed(text, "children");
  }
  return contributes ? composed(`${message}\n\n${text}`, "both") : composed(message, "prop");
}

function composed(text: string, source: GitCommitMessageSource): ComposedCommitMessage {
  return { message: admitCommitMessage(canonicalCommitMessage(text)), source };
}

/**
 * The message, once it is one this host can hand to Git unchanged.
 *
 * Applied wherever a request enters rather than only where a document writes
 * one: the Api is public, and a caller reaching it directly commits the same
 * bytes under the same retained digest.
 *
 * An unpaired surrogate is refused rather than replaced. The way to Git is
 * UTF-8, and encoding one produces U+FFFD, so what was committed would differ
 * from what the run's history says was committed. A message that is not already
 * canonical is refused for the same reason from the other direction: quietly
 * rewriting a caller's bytes would leave the digest describing something the
 * caller never wrote.
 */
export function admitCommitMessage(message: string): string {
  if (!wellFormedText(message)) {
    invalid(
      "needs a message that is well-formed text. It holds an unpaired surrogate, which this " +
        "host cannot hand to Git as written.",
    );
  }
  if (message === BLANK) {
    invalid("needs a message with text in it. Whitespace alone is not a message.");
  }
  if (canonicalCommitMessage(message) !== message) {
    invalid(
      "needs a canonical message: LF line endings, no whitespace at the end, and exactly one " +
        "final newline. Nothing is normalized on the way to Git, because what this run retains " +
        "is a digest of the bytes it committed.",
    );
  }
  return message;
}

/** The source classification this value is, or a refusal. */
export function admitMessageSource(value: unknown): GitCommitMessageSource {
  const source = parseGitCommitMessageSource(value);
  if (source === undefined) {
    invalid("needs to say where its message came from: prop, children or both.");
  }
  return source;
}

export default function* GitCommit(props: Record<string, Json>): Operation<string> {
  const message =
    typeof props.message === "string" && props.message !== "" ? props.message : undefined;

  // Before anything of this element's own exists. Children are expansions,
  // effects and transactions in their own right, and a commit that began first
  // would be describing an index its own content had not finished writing.
  const body = (yield* hasContent()) ? yield* content() : "";
  const composed = composeCommitMessage(message, body);

  const repository = yield* currentRepository();
  if (repository === undefined) {
    throw new GitOperationAuthorityError(
      COMMIT,
      "it is written outside a lexical <Repository>, so there is no repository in scope for a " +
        "commit to be a commit in",
    );
  }

  const result = yield* GitComposition.operations.commitIndex({
    repository,
    workingDirectory: yield* cwd(),
    message: composed.message,
    messageSource: composed.source,
  });
  return result.commit;
}
