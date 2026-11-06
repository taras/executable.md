/**
 * Commit the staged index and bind its full object id
 * (specs/workflow-workspace-spec.md §7.3), or read an existing commit (§7.8).
 *
 * `<Git.Commit message={summary} as="commit"><Git.Add paths="notes.md" /></Git.Commit>`
 * completes child expansions and their own transactions before describing the
 * commit effect. It performs no implicit staging, amend, empty commit or signing.
 *
 * The message prop, rendered content or both supply the message; both place the
 * prop first and content one blank line later. Canonicalization changes line
 * endings to LF, removes trailing whitespace and adds one final newline, preserving
 * leading and interior text. Git receives those bytes verbatim; the retained digest
 * and byte length describe them. The component renders nothing and requires `as`.
 *
 * `<Git.Commit ref={sha} yq=".message" as="commit" />` reads instead. `ref`
 * selects the read, which is self-closing only; a message, content, or a paired
 * element with any read prop is refused before a child expands or a provider is
 * asked, and `verify`, `yq` or `maxBytes` without `ref` is refused the same way.
 * Which form an element was written in comes from the scan, never from a
 * replaceable `hasContent()` answer.
 */

import { cwd } from "@executablemd/runtime";
import { content, hasContent } from "@executablemd/core";
import type { FormDeclaration, PropsSchema, ReturnsSchema } from "@executablemd/core";
import type { Operation } from "effection";
import type { Json } from "@executablemd/durable-streams";
import { Git } from "../git-api.ts";
import { GitQuery } from "../../git.ts";
import { selectedRepository } from "../context.ts";
import { GitObservationError, GitOperationAdmissionError, GitOperationError } from "../errors.ts";
import { admitCommitReadRequest } from "../observation-api.ts";
import { gitCommitPageJson } from "../observation-records.ts";
import { wellFormedText } from "../parse.ts";
import { parseGitCommitMessageSource } from "../git-records.ts";
import type { GitCommitMessageSource } from "../git-records.ts";

/** The component name, as a document writes it and as a failure names it. */
export const COMMIT = "<Git.Commit>";

export const props: PropsSchema = {
  type: "object",
  properties: {
    message: { type: "string", minLength: 1 },
    ref: { type: "string", minLength: 1 },
    verify: { type: "boolean" },
    yq: { type: "string" },
    maxBytes: { type: "integer", minimum: 1 },
  },
  additionalProperties: false,
};

const NAVIGATION = { type: ["string", "null"] };

/**
 * A created commit's full object id, in either algorithm a repository names its
 * objects with, or one page of what a read selected.
 */
export const returns: ReturnsSchema = {
  anyOf: [
    { type: "string", pattern: "^([0-9a-f]{40}|[0-9a-f]{64})$" },
    {
      type: "object",
      properties: { value: {}, next: NAVIGATION, prev: NAVIGATION, last: NAVIGATION },
      required: ["value", "next", "prev", "last"],
      additionalProperties: false,
    },
  ],
};

/** The props that belong to the read form alone. */
const READ_PROPS = ["ref", "verify", "yq", "maxBytes"] as const;

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
 * empty half. Whether text was contributed is asked of a canonicalized copy and
 * decided there; the body that goes on to be composed is the rendered body
 * itself, unread and unedited.
 *
 * Nothing here trims. A blank line the content begins with is part of the
 * message that content is, and the one place whitespace is removed is the end of
 * the whole composed message — once, below.
 */
export function composeCommitMessage(
  message: string | undefined,
  body: string,
): ComposedCommitMessage {
  const contributes = canonicalCommitMessage(body) !== BLANK;
  if (message === undefined) {
    if (!contributes) {
      invalid(
        "needs a message. Write one as a message prop, as content that renders text, or as both.",
      );
    }
    return composed(body, "children");
  }
  return contributes ? composed(`${message}\n\n${body}`, "both") : composed(message, "prop");
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

function readRefusal(reason: "invalid-invocation" | "unexpected-content", sentence: string) {
  return new GitObservationError(COMMIT, reason, `${COMMIT} ${sentence}`);
}

/**
 * Read the commit `ref` names, before anything of the element's own runs.
 *
 * Nothing here expands content: the read form is self-closing, so there is
 * none, and a message beside `ref` is refused rather than ignored.
 */
function* read(props: Record<string, Json>): Operation<Json> {
  if (props.message !== undefined) {
    throw readRefusal(
      "invalid-invocation",
      "reads the commit ref names, so it takes no message. Remove ref to create a commit, or " +
        "remove message to read one.",
    );
  }
  const request = admitCommitReadRequest(COMMIT, props);
  const repository = yield* selectedRepository();
  if (repository === undefined) {
    throw new GitOperationAdmissionError(
      COMMIT,
      "it is written outside a lexical <Repository>, so there is no repository in scope to read",
    );
  }
  return gitCommitPageJson(
    yield* GitQuery.operations.commit({
      repository,
      workingDirectory: yield* cwd(),
      request,
    }),
  );
}

/** The read prop this creation names, if any. */
function readProp(props: Record<string, Json>): string | undefined {
  return READ_PROPS.find((name) => props[name] !== undefined);
}

function* selfClosing(props: Record<string, Json>): Operation<Json> {
  if (props.ref !== undefined) {
    return yield* read(props);
  }
  const named = readProp(props);
  if (named !== undefined) {
    throw readRefusal(
      "invalid-invocation",
      `was given ${named} without ref. ${named} belongs to the read form, ` +
        '<Git.Commit ref="…" as="…" />, so write the ref to read or remove it to create a commit.',
    );
  }
  return yield* GitCommit(props);
}

function* paired(props: Record<string, Json>): Operation<Json> {
  const named = readProp(props);
  if (named !== undefined) {
    throw readRefusal(
      "unexpected-content",
      named === "ref"
        ? "reads the commit ref names and renders nothing of its own, so a read is written " +
            'self-closing: <Git.Commit ref="…" as="…" />. Its content was not expanded.'
        : `was given ${named}, which belongs to the self-closing read form. Its content was not ` +
            "expanded.",
    );
  }
  return yield* GitCommit(props);
}

/**
 * Both forms, decided by how the element was written.
 *
 * A self-closing element with `ref` reads; every other self-closing element and
 * every paired one creates, exactly as before, unless it names a read prop.
 */
export const commitForm: FormDeclaration = {
  forms: "both",
  "self-closing": selfClosing,
  paired,
};

/** Create a commit from the staged index, exactly as the creation form always has. */
function* GitCommit(props: Record<string, Json>): Operation<string> {
  const message =
    typeof props.message === "string" && props.message !== "" ? props.message : undefined;

  // Before anything of this element's own exists. Children are expansions,
  // effects and transactions in their own right, and a commit that began first
  // would be describing an index its own content had not finished writing.
  const body = (yield* hasContent()) ? yield* content() : "";
  const composed = composeCommitMessage(message, body);

  const repository = yield* selectedRepository();
  if (repository === undefined) {
    throw new GitOperationAdmissionError(
      COMMIT,
      "it is written outside a lexical <Repository>, so there is no repository in scope for a " +
        "commit to be a commit in",
    );
  }

  const result = yield* Git.operations.commit({
    repository,
    workingDirectory: yield* cwd(),
    message: composed.message,
    messageSource: composed.source,
  });
  return result.commit;
}
