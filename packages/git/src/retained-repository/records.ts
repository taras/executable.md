/**
 * What one REPL entry's local file and directory work looks like on the wire.
 *
 * A foreground REPL entry that writes a file inside the checkout the person is
 * standing in records what the write produced. Reopen the entry and the saved
 * result answers again, without touching the file — which is what lets an entry
 * interrupted at a question be continued instead of repeated.
 *
 * Four operations are recorded and nothing else: a `<File>` text read, a
 * `<File>` write, a `<File.Delete />`, and the directory a `<Dir>` ensures. A
 * call outside the checkout is ordinary filesystem behavior and is recorded by
 * nothing here, because giving it a record would place it in a checkout it is not in.
 * Globs, path checks and temporary directories are recorded nowhere: a read is
 * retained because a document binds its text and a continuation has to offer
 * the same binding, and those three bind nothing.
 *
 * ## Identity is the request, and position is the journal's
 *
 * A record's name is the digest of the record version, the operation kind and
 * the complete authored request — the working directory, the path, and for a
 * write the exact content. Two entries that write the same text produce the same
 * name, and that is allowed: each entry executes against its own segment of the
 * one physical history, so a name another entry wrote is never inside the range
 * this one replays. Two *equal* writes in one entry are one name at two ordered
 * positions, and telling them apart is the durable engine's own positional
 * matching rather than anything here: nothing in this module searches history by
 * name, and a repeated name is valid.
 *
 * The request is named as the document wrote it. Nothing is canonicalized for
 * naming, because a path resolved through the filesystem is a fact about the
 * host at that moment and the question the document asked is not.
 *
 * ## What a result may carry
 *
 * The ordinary Files vocabulary and no more. A write keeps the validated
 * success it was given, `publication` included; a delete and an ensure keep the
 * absence of a payload that those operations answer with, rather than a write
 * receipt they never produced. A refusal keeps the structural failure data the
 * provider reported, so a continuation reconstructs the same `Result` the live
 * call returned.
 *
 * Nothing else is retained — no native exception, no credential, no directory
 * listing, no bytes read from another file and no handle.
 */

import { Err, Ok, until } from "effection";
import type { Operation, Result } from "effection";
import type { Json } from "@executablemd/durable-streams";
import { canonicalJson } from "@executablemd/workflow";
import {
  FILES_ERROR_MESSAGE,
  FilesError,
  parseFilesFailure,
  parseFileWriteFailure,
  parseFileWriteSuccess,
} from "@executablemd/runtime";
import type { FilesErrorData, FileWriteSuccess } from "@executablemd/runtime";
import { members } from "../composition/parse.ts";

/** The record shape this host writes and the only one it reads. */
export const REPL_REPOSITORY_VERSION = 1;

/** The durable type one completed local operation is journaled under. */
export const REPL_REPOSITORY_LOCAL = "repl_repository_local";

/** The durable type the entry's ambient routing facts are journaled under. */
export const REPL_REPOSITORY_SELECTION = "repl_repository_selection";

/**
 * The namespace every record name of this feature begins with.
 *
 * Shared with the placement records beside these, because a second prefix
 * would be a second namespace for one feature's history.
 */
export const RECORD_PREFIX = "executablemd.git.repl-repository";

/** Which local operation a record describes. */
export type ReplLocalOperation = "file-read" | "file-write" | "file-delete" | "dir-ensure";

const LOCAL_OPERATIONS: readonly ReplLocalOperation[] = [
  "file-read",
  "file-write",
  "file-delete",
  "dir-ensure",
];

/**
 * What one recorded operation produced.
 *
 * A write's validated receipt, a read's exact text, or the absence a delete and
 * an ensure answer with. Nothing else is a value this format carries.
 */
export type ReplLocalValue = FileWriteSuccess | string | undefined;

/** What one recorded call asked for. */
export interface ReplLocalRequest {
  /** The contextual working directory the path is relative to. */
  readonly cwd: string;
  /** The path exactly as the document wrote it. */
  readonly path: string;
  /** The exact expanded content a write asked for; absent for the other three. */
  readonly content?: string;
}

/** The routing facts the entry's ambient discovery found, or their absence. */
export interface ReplAmbientCheckout {
  /** The canonical root of the checkout the entry started in. */
  readonly checkoutRoot: string;
  /** The canonical common Git directory, which identifies the repository. */
  readonly commonDirectory: string;
}

/** One completed local operation, as a continuation reads it back. */
export interface ReplLocalRecord {
  readonly version: typeof REPL_REPOSITORY_VERSION;
  readonly operation: ReplLocalOperation;
  /** The digest of the version, operation kind and authored request. */
  readonly fingerprint: string;
  readonly request: ReplLocalRequest;
  /**
   * What performing it produced, as the ordinary `Result` it was.
   *
   * A write carries the validated success it was given; a read carries the exact
   * text it answered with; a delete and an ensure carry the absence those
   * operations answer with. A refusal carries a `FilesError` rebuilt from the
   * structural data the provider reported.
   */
  readonly outcome: Result<ReplLocalValue>;
}

/** The entry's saved ambient routing, as a continuation reads it back. */
export interface ReplSelectionRecord {
  readonly version: typeof REPL_REPOSITORY_VERSION;
  /** The directory discovery started from. */
  readonly cwd: string;
  /** What it found, or `null` for a directory inside no checkout. */
  readonly checkout: ReplAmbientCheckout | null;
}

/** The stable name one local operation's record is journaled under. */
export function replLocalRecordName(record: {
  readonly operation: ReplLocalOperation;
  readonly fingerprint: string;
}): string {
  return canonicalJson([
    RECORD_PREFIX,
    "local",
    REPL_REPOSITORY_VERSION,
    record.operation,
    record.fingerprint,
  ]);
}

/** The stable name the entry's ambient routing record is journaled under. */
export function replSelectionRecordName(record: { readonly fingerprint: string }): string {
  return canonicalJson([RECORD_PREFIX, "selection", REPL_REPOSITORY_VERSION, record.fingerprint]);
}

/** The digest of everything one authored mutation asks. */
export function replLocalFingerprint(input: {
  readonly operation: ReplLocalOperation;
  readonly request: ReplLocalRequest;
}): Operation<string> {
  return digest({
    version: REPL_REPOSITORY_VERSION,
    operation: input.operation,
    request: requestJson(input.request),
  });
}

/** The digest of the directory this entry's discovery starts from. */
export function replSelectionFingerprint(input: { readonly cwd: string }): Operation<string> {
  return digest({ version: REPL_REPOSITORY_VERSION, selection: { cwd: input.cwd } });
}

/** The payload one completed local operation is journaled with. */
export function replLocalRecordJson(input: {
  readonly operation: ReplLocalOperation;
  readonly fingerprint: string;
  readonly request: ReplLocalRequest;
  readonly outcome: Result<ReplLocalValue>;
}): Json {
  const stated = {
    version: REPL_REPOSITORY_VERSION,
    operation: input.operation,
    fingerprint: input.fingerprint,
    request: requestJson(input.request),
  };
  if (input.outcome.ok) {
    const success = input.outcome.value;
    if (success === undefined) {
      return { ...stated, success: null };
    }
    return { ...stated, success: typeof success === "string" ? success : { ...success } };
  }
  return { ...stated, refusal: { ...failureData(input.outcome.error) } };
}

/** The payload this entry's ambient routing is journaled with. */
export function replSelectionRecordJson(input: {
  readonly cwd: string;
  readonly checkout: ReplAmbientCheckout | undefined;
}): Json {
  return {
    version: REPL_REPOSITORY_VERSION,
    cwd: input.cwd,
    checkout:
      input.checkout === undefined
        ? null
        : {
            checkoutRoot: input.checkout.checkoutRoot,
            commonDirectory: input.checkout.commonDirectory,
          },
  };
}

/**
 * The local operation this saved value describes, or `undefined`.
 *
 * Total, and exact about its members: a payload carrying anything this version
 * did not write is not a record it can act on, because the operation may have
 * happened and may not. The caller refuses rather than guessing.
 */
export function parseReplLocalRecord(value: unknown): ReplLocalRecord | undefined {
  const refusal = members(value, ["version", "operation", "fingerprint", "request", "refusal"]);
  const success =
    refusal === undefined
      ? members(value, ["version", "operation", "fingerprint", "request", "success"])
      : undefined;
  const read = refusal ?? success;
  if (read === undefined) {
    return undefined;
  }
  if (read["version"] !== REPL_REPOSITORY_VERSION) {
    return undefined;
  }
  const fingerprint = string(read["fingerprint"]);
  const operation = parseReplLocalOperation(read["operation"]);
  if (fingerprint === undefined || operation === undefined) {
    return undefined;
  }
  const request = parseReplLocalRequest(read["request"], operation);
  if (request === undefined) {
    return undefined;
  }
  const outcome =
    refusal === undefined
      ? parseSuccess(read["success"], operation)
      : parseRefusal(read["refusal"]);
  if (outcome === undefined) {
    return undefined;
  }
  return Object.freeze({
    version: REPL_REPOSITORY_VERSION,
    operation,
    fingerprint,
    request,
    outcome,
  });
}

/** The ambient routing this saved value describes, or `undefined`. */
export function parseReplSelectionRecord(value: unknown): ReplSelectionRecord | undefined {
  const read = members(value, ["version", "cwd", "checkout"]);
  if (read === undefined || read["version"] !== REPL_REPOSITORY_VERSION) {
    return undefined;
  }
  const cwd = string(read["cwd"]);
  if (cwd === undefined) {
    return undefined;
  }
  const stated = read["checkout"];
  if (stated === null) {
    return Object.freeze({ version: REPL_REPOSITORY_VERSION, cwd, checkout: null });
  }
  const checkout = members(stated, ["checkoutRoot", "commonDirectory"]);
  if (checkout === undefined) {
    return undefined;
  }
  const checkoutRoot = string(checkout["checkoutRoot"]);
  const commonDirectory = string(checkout["commonDirectory"]);
  if (checkoutRoot === undefined || commonDirectory === undefined) {
    return undefined;
  }
  return Object.freeze({
    version: REPL_REPOSITORY_VERSION,
    cwd,
    checkout: Object.freeze({ checkoutRoot, commonDirectory }),
  });
}

/** The operation kind this value names, or `undefined`. */
export function parseReplLocalOperation(value: unknown): ReplLocalOperation | undefined {
  return LOCAL_OPERATIONS.find((operation) => operation === value);
}

/** The version a payload states, or `undefined` when it states none. */
export function statedReplRecordVersion(payload: unknown): number | undefined {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return undefined;
  }
  const read = Reflect.get(payload, "version");
  return typeof read === "number" && Number.isSafeInteger(read) ? read : undefined;
}

/**
 * The authored request a saved record carries, or `undefined`.
 *
 * The content and the operation have to agree. A write without content, or a
 * delete carrying some, is a record describing an operation this host does not
 * perform, which says nothing trustworthy about work already done.
 */
function parseReplLocalRequest(
  value: unknown,
  operation: ReplLocalOperation,
): ReplLocalRequest | undefined {
  const read =
    operation === "file-write"
      ? members(value, ["cwd", "path", "content"])
      : members(value, ["cwd", "path"]);
  if (read === undefined) {
    return undefined;
  }
  const cwd = string(read["cwd"]);
  const path = anyString(read["path"]);
  if (cwd === undefined || path === undefined) {
    return undefined;
  }
  if (operation !== "file-write") {
    return Object.freeze({ cwd, path });
  }
  const content = anyString(read["content"]);
  return content === undefined ? undefined : Object.freeze({ cwd, path, content });
}

/**
 * The success a saved record carries, as the `Result` the operation produced.
 *
 * A write's success is the validated outcome data it was given, and a read's is
 * the exact text. The other two answer with nothing at all, and `null` is how
 * that is written down: a receipt manufactured for them would state what the
 * operation never did.
 */
function parseSuccess(
  value: unknown,
  operation: ReplLocalOperation,
): Result<ReplLocalValue> | undefined {
  if (operation === "file-read") {
    return typeof value === "string" ? Ok(value) : undefined;
  }
  if (operation !== "file-write") {
    return value === null ? Ok(undefined) : undefined;
  }
  const success = parseFileWriteSuccess(value);
  return success === undefined ? undefined : Ok(success);
}

/** The refusal a saved record carries, rebuilt as the failure it was. */
function parseRefusal(value: unknown): Result<never> | undefined {
  const data = failureOf(carried(value));
  return data === undefined ? undefined : Err(new FilesError(data));
}

/**
 * The structural data behind one ordinary failure.
 *
 * Read off the error and validated before it is written down: an error this
 * boundary cannot describe is not a refusal it may save as one, so the caller's
 * provider-contract classification is what reports it instead.
 */
function failureData(error: Error): FilesErrorData {
  const data = failureOf(error);
  if (data === undefined) {
    throw new TypeError("a retained refusal carries no ordinary Files failure data");
  }
  return data;
}

/** Whether this error is one the record format can carry as a refusal. */
export function retainableRefusal(error: Error): boolean {
  return failureOf(error) !== undefined;
}

/**
 * The validated failure data one error carries, write or otherwise.
 *
 * A write's data is asked for first because its rules are the stricter pair: a
 * phase, the target that phase implies, and which of a reason and a cleanup
 * reason may appear beside them.
 */
function failureOf(error: unknown): FilesErrorData | undefined {
  return parseFileWriteFailure(error) ?? parseFilesFailure(error);
}

/**
 * Saved failure data on a carrier, for the validators that read an error.
 *
 * The runtime's two validators take the error rather than the record, because
 * at every other boundary the error is what they are handed. Carrying saved data
 * on a plain one keeps them the single authority on whether a combination is one
 * a consumer may read — a second implementation of the write phase and target
 * rules beside them would be a second answer to the same question.
 */
function carried(data: unknown): Error {
  return Object.assign(new Error(FILES_ERROR_MESSAGE), { data });
}

function requestJson(request: ReplLocalRequest): Json {
  return request.content === undefined
    ? { cwd: request.cwd, path: request.path }
    : { cwd: request.cwd, path: request.path, content: request.content };
}

/**
 * The SHA-256 digest of one canonical value, as every name here is built from.
 *
 * Shared with the placement records beside these: two implementations of one
 * digest would be two answers to what a record is named.
 */
export function* digest(value: Json): Operation<string> {
  const encoded = new TextEncoder().encode(canonicalJson(value));
  const computed = yield* until(crypto.subtle.digest("SHA-256", encoded));
  return Array.from(new Uint8Array(computed), (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

/** A non-empty string, which is what every identity member here is. */
function string(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * Any string, which is what an authored path and authored content are.
 *
 * A document may write `<File.Delete path="" />`, and the empty path is what the
 * ordinary lexical refusal is about. Refusing to read it back here would leave a
 * continuation unable to parse a record this host itself wrote.
 */
function anyString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
