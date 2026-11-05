/**
 * The native side of `<Git.Commit ref>`: one commit's stored facts, read from
 * the contained view, optionally verified under the checkout's own
 * configuration, and selected by yq.
 *
 * The facts are the commit object exactly as stored. Names and email addresses
 * are what the identity lines hold, with no mailmap and no substitution; a
 * message is its stored bytes, untrimmed; parents keep their stored order and a
 * root commit has none. A date is the stored instant written at the stored
 * offset, always `YYYY-MM-DDTHH:MM:SS±HH:MM`, so `+0000` and `-0000` stay
 * distinguishable. Text is decoded as strict UTF-8, and a commit that is not —
 * or names another encoding — is refused rather than repaired.
 *
 * Whether a commit is signed is read from the object itself, from the signature
 * header for the repository's own algorithm. It is never inferred from what a
 * verifier printed.
 */

import type { Operation } from "effection";
import { GitObservationError } from "../../composition/errors.ts";
import type { GitObjectFormat } from "../../composition/records.ts";
import type { GitCommitPage, GitCommitReadRequest } from "../../composition/observation-api.ts";
import { selectCommitPage } from "../../composition/commit-page.ts";
import type {
  GitCommitFacts,
  GitCommitIdent,
  GitVerifyCommitResult,
} from "../../composition/commit-page.ts";
import type { CommitSignatureFormat, CommitVerifier } from "../run-composition/verification.ts";

/** The contained-view reads one commit read needs, supplied by the observation that owns them. */
export interface CommitObjectReads {
  /** The full commit id this revision names in the checkout, or `undefined`. */
  resolve(revision: string): Operation<string | undefined>;
  /** The type of whatever object this revision names, or `undefined` when it names none. */
  objectType(revision: string): Operation<string | undefined>;
  /** The stored bytes of this commit object. */
  commitBytes(commit: string): Operation<Uint8Array>;
  /** Refuse because the selected repository could not supply what was needed. */
  unreadable(what: string): never;
}

/** The parsed object, before verification and selection. */
interface StoredCommit {
  readonly tree: string;
  readonly parents: readonly string[];
  readonly author: GitCommitIdent;
  readonly committer: GitCommitIdent;
  readonly message: string;
  readonly signed: boolean;
  readonly signature: CommitSignatureFormat | null;
}

const OBJECT_ID: Readonly<Record<GitObjectFormat, RegExp>> = {
  sha1: /^[0-9a-f]{40}$/,
  sha256: /^[0-9a-f]{64}$/,
};

/** The header a commit carries its signature in, for the repository's own algorithm. */
const SIGNATURE_HEADER: Readonly<Record<GitObjectFormat, string>> = {
  sha1: "gpgsig",
  sha256: "gpgsig-sha256",
};

const SIGNATURE_FORMATS: readonly (readonly [string, CommitSignatureFormat])[] = [
  ["-----BEGIN PGP SIGNATURE-----", "openpgp"],
  ["-----BEGIN PGP MESSAGE-----", "openpgp"],
  ["-----BEGIN SIGNED MESSAGE-----", "x509"],
  ["-----BEGIN SSH SIGNATURE-----", "ssh"],
];

function refusal(
  element: string,
  reason: "invalid-revision" | "undecodable-text",
  sentence: string,
): GitObservationError {
  return new GitObservationError(element, reason, `${element} ${sentence}`);
}

function strictText(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

/**
 * ISO 8601 for this stored instant at this stored offset, or `undefined` when
 * either is not one Git writes.
 */
function storedDate(seconds: string, offset: string): string | undefined {
  const instant = /^\d+$/.test(seconds) ? Number(seconds) : Number.NaN;
  const zone = /^([+-])(\d{2})([0-5]\d)$/.exec(offset);
  if (!Number.isSafeInteger(instant) || zone === null) {
    return undefined;
  }
  const [, sign, hours, minutes] = zone;
  const shift = (Number(hours) * 60 + Number(minutes)) * (sign === "-" ? -1 : 1);
  const local = new Date((instant + shift * 60) * 1000);
  if (Number.isNaN(local.getTime())) {
    return undefined;
  }
  const written = local.toISOString();
  return /^\d{4}-/.test(written) ? `${written.slice(0, 19)}${sign}${hours}:${minutes}` : undefined;
}

/** One `Name <email> seconds offset` line, as stored, or `undefined`. */
function storedIdent(value: string): GitCommitIdent | undefined {
  const open = value.indexOf("<");
  const close = value.indexOf(">", open);
  if (open < 0 || close < 0) {
    return undefined;
  }
  const when = /^ (\d+) ([+-]\d{4})$/.exec(value.slice(close + 1));
  if (when === null) {
    return undefined;
  }
  const date = storedDate(when[1], when[2]);
  if (date === undefined) {
    return undefined;
  }
  const before = value.slice(0, open);
  return {
    name: before.endsWith(" ") ? before.slice(0, -1) : before,
    email: value.slice(open + 1, close),
    date,
  };
}

/** The headers of a commit object, continuation lines joined to the header they continue. */
function headersOf(text: string): { readonly key: string; value: string }[] | undefined {
  const headers: { readonly key: string; value: string }[] = [];
  for (const line of text.split("\n")) {
    const previous = headers.at(-1);
    if (line.startsWith(" ")) {
      if (previous === undefined) {
        return undefined;
      }
      previous.value += `\n${line.slice(1)}`;
      continue;
    }
    const space = line.indexOf(" ");
    if (space <= 0) {
      return undefined;
    }
    headers.push({ key: line.slice(0, space), value: line.slice(space + 1) });
  }
  return headers;
}

/** The stored facts in this commit object, or the read's refusal. */
function parseCommitObject(
  element: string,
  commit: string,
  bytes: Uint8Array,
  format: GitObjectFormat,
  reads: Pick<CommitObjectReads, "unreadable">,
): StoredCommit {
  const text = strictText(bytes);
  if (text === undefined) {
    throw refusal(
      element,
      "undecodable-text",
      `read commit ${commit}, whose stored text is not valid UTF-8. Nothing was replaced or ` +
        "repaired, so this commit cannot be read as text.",
    );
  }
  const separator = text.indexOf("\n\n");
  const headerText = separator < 0 ? text.replace(/\n$/, "") : text.slice(0, separator);
  const message = separator < 0 ? "" : text.slice(separator + 2);
  const headers = headersOf(headerText);
  const malformed = (): never =>
    reads.unreadable(`commit ${commit} as a well-formed commit object`);
  if (headers === undefined || headers[0]?.key !== "tree") {
    return malformed();
  }
  const id = OBJECT_ID[format];
  const one = (key: string): string => {
    const found = headers.filter((header) => header.key === key);
    return found.length === 1 ? found[0].value : malformed();
  };
  const tree = one("tree");
  const parents = headers.filter((header) => header.key === "parent").map((header) => header.value);
  if (!id.test(tree) || parents.some((parent) => !id.test(parent))) {
    return malformed();
  }
  const encoding = headers.find((header) => header.key === "encoding");
  if (encoding !== undefined && !/^utf-?8$/i.test(encoding.value)) {
    throw refusal(
      element,
      "undecodable-text",
      `read commit ${commit}, which declares its text encoding as ` +
        `${JSON.stringify(encoding.value)}. Only UTF-8 is read, and nothing is converted.`,
    );
  }
  const author = storedIdent(one("author"));
  const committer = storedIdent(one("committer"));
  if (author === undefined || committer === undefined) {
    return reads.unreadable(`a valid author and committer line with a date from commit ${commit}`);
  }
  const signature = headers.find((header) => header.key === SIGNATURE_HEADER[format]);
  const first = signature?.value.split("\n")[0];
  return {
    tree,
    parents,
    author,
    committer,
    message,
    signed: signature !== undefined,
    signature: SIGNATURE_FORMATS.find(([line]) => line === first)?.[1] ?? null,
  };
}

/**
 * Read, optionally verify, and select one commit.
 *
 * Runs inside the observation that owns the contained view, so every native
 * child — the verifier's included — is joined before a page exists.
 */
export function* observeCommit(
  reads: CommitObjectReads,
  element: string,
  request: GitCommitReadRequest,
  root: string,
  format: GitObjectFormat,
  verifier: CommitVerifier,
): Operation<GitCommitPage> {
  const commit = yield* reads.resolve(request.ref);
  if (commit === undefined) {
    const type = yield* reads.objectType(request.ref);
    throw refusal(
      element,
      "invalid-revision",
      type === undefined
        ? `was given ref=${JSON.stringify(request.ref)}, which names no object in the selected ` +
            "repository. Write a revision that names a commit, then read it again."
        : `was given ref=${JSON.stringify(request.ref)}, which names a ${type} rather than a ` +
            "commit. Write a revision that names a commit, then read it again.",
    );
  }
  const stored = parseCommitObject(
    element,
    commit,
    yield* reads.commitBytes(commit),
    format,
    reads,
  );
  let verification: GitVerifyCommitResult | null = null;
  if (request.verify) {
    const receipt = yield* verifier({ root, commit, format: stored.signature });
    const stdout = strictText(receipt.stdout);
    const stderr = strictText(receipt.stderr);
    if (stdout === undefined || stderr === undefined) {
      throw refusal(
        element,
        "undecodable-text",
        `verified commit ${commit}, and git verify-commit wrote ` +
          `${stdout === undefined ? "standard output" : "standard error"} that is not valid ` +
          "UTF-8. Nothing was replaced or truncated, so the receipt cannot be returned as text.",
      );
    }
    verification = {
      signed: stored.signed,
      verifier_unavailable: stored.signed && receipt.verifierUnavailable,
      exitCode: receipt.exitCode,
      stdout,
      stderr,
    };
  }
  const facts: GitCommitFacts = {
    sha: commit,
    author: stored.author,
    committer: stored.committer,
    message: stored.message,
    tree: { sha: stored.tree },
    parents: stored.parents.map((sha) => ({ sha })),
    git_verify_commit_result: verification,
  };
  return yield* selectCommitPage(element, request, facts);
}
