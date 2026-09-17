/**
 * A workflow definition that is the source itself.
 *
 * The Git descriptor beside this one names a document that lives somewhere
 * else: an object id, a path inside it, and a host able to read both. A source
 * bundle instead identifies the exact bytes, so a run of a file outside a
 * repository, of an untracked file, or of a file edited since its last commit
 * is one immutable definition the moment it is retained.
 *
 * Identity is content addressing over logical paths. A logical path is a
 * portable name inside the bundle, never a host filesystem path — the
 * containing directory, the absolute path, the invocation working directory
 * and the platform separator are all retrieval facts, so two hosts holding the
 * same bytes under the same logical entrypoint hold the same definition.
 *
 * The target is deliberately outside the bundle hash: choosing a section does
 * not change the bytes in the bundle. It stays part of the complete definition
 * identity, which is what keeps a run of one section distinct from a run of the
 * whole document.
 *
 * Hashing is domain separated and length framed, through the platform's own
 * `crypto`. This module names no host: it is the same identity whichever
 * provider retains it.
 */

import { Err, Ok, type Operation, type Result, until } from "effection";
import { isCanonicalDocumentTarget, isComponentName } from "@executablemd/core";
import type { Json } from "@executablemd/durable-streams";
import { WorkflowDefinitionError, WorkflowRequestError } from "./errors.ts";
import {
  describe,
  type Members,
  parseMembers,
  parseStringMember,
  requireMemberNames,
} from "./members.ts";

/**
 * The exact bytes a workflow runs, named by logical path.
 *
 * `sources` is the complete closure the run executes, in canonical UTF-8 byte
 * order of `path`, with `entrypoint` naming exactly one of them. `components`
 * maps authored component names onto members of that closure, so adding,
 * removing or changing a retained dependency changes `bundleHash`.
 */
export interface SourceBundleWorkflowDefinitionV2 {
  readonly version: 2;
  readonly kind: "source-bundle";
  readonly hashAlgorithm: "sha256";
  readonly bundleHash: string;
  readonly entrypoint: string;
  readonly sources: readonly SourceBundleEntryV2[];
  /** One exact canonical document target, without a leading `#`. */
  readonly targetPath?: string;
  readonly components?: readonly SourceBundleComponentV2[];
}

/** One retained source: its logical path, and what its bytes hash and weigh. */
export interface SourceBundleEntryV2 {
  readonly path: string;
  readonly sourceHash: string;
  readonly byteLength: number;
}

/** One authored component name, resolved onto a retained source. */
export interface SourceBundleComponentV2 {
  readonly name: string;
  readonly path: string;
}

/** The exact bytes offered for one logical path when a run is created. */
export interface SourceBundleSnapshotEntryV2 {
  readonly path: string;
  readonly bytes: Uint8Array;
}

/** What a bundle hash is computed over: the closure, and nothing else. */
export interface SourceBundleIdentityV2 {
  readonly entrypoint: string;
  readonly sources: readonly SourceBundleEntryV2[];
  readonly components?: readonly SourceBundleComponentV2[];
}

const SOURCE_DOMAIN = "executablemd.workflow.source.v2";
const BUNDLE_DOMAIN = "executablemd.workflow.bundle.v2";

/** Hexadecimal digits in a SHA-256 hash, and the bytes they decode to. */
const HASH_DIGITS = 64;
const HASH_BYTES = 32;

const MEMBER_NAMES = [
  "version",
  "kind",
  "hashAlgorithm",
  "bundleHash",
  "entrypoint",
  "sources",
  "targetPath",
  "components",
];

const SOURCE_MEMBER_NAMES = ["path", "sourceHash", "byteLength"];
const COMPONENT_MEMBER_NAMES = ["name", "path"];
const SNAPSHOT_MEMBER_NAMES = ["path", "bytes"];

const encoder = new TextEncoder();

/**
 * One decoder, refusing rather than replacing.
 *
 * `ignoreBOM` keeps a leading U+FEFF as a character instead of consuming it:
 * the bytes are the identity, and a decoder that silently dropped three of them
 * would hand the Markdown parser something the bundle hash does not describe.
 */
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function fail(reason: string, path: string): Error {
  return new WorkflowDefinitionError(reason, path);
}

/**
 * The source-bundle definition a value describes.
 *
 * Parsed rather than asserted, and parsed closed: a descriptor reaches storage
 * from a host and comes back out of a database column, and neither is trusted
 * to hold only the members this shape declares. Arrays must arrive canonical —
 * a parser that sorted them would turn two spellings of one malformed value
 * into one accepted identity.
 */
export function parseSourceBundleDefinition(
  value: unknown,
): Result<SourceBundleWorkflowDefinitionV2> {
  try {
    return Ok(parseDefinition(value));
  } catch (error) {
    if (error instanceof WorkflowDefinitionError) {
      return Err(error);
    }
    throw error;
  }
}

function parseDefinition(value: unknown): SourceBundleWorkflowDefinitionV2 {
  const members = parseMembers(value, "$", fail);
  requireMemberNames(members, MEMBER_NAMES, "$", fail);

  if (members.get("version") !== 2) {
    throw fail("expected version 2", "$.version");
  }
  if (parseStringMember(members, "kind", "$", fail) !== "source-bundle") {
    throw fail('expected the kind "source-bundle"', "$.kind");
  }
  if (parseStringMember(members, "hashAlgorithm", "$", fail) !== "sha256") {
    throw fail('expected the hash algorithm "sha256"', "$.hashAlgorithm");
  }

  const bundleHash = parseHash(parseStringMember(members, "bundleHash", "$", fail), "$.bundleHash");
  const sources = parseSources(members);
  const entrypoint = parseEntrypoint(parseStringMember(members, "entrypoint", "$", fail), sources);
  const targetPath = parseTargetPath(members);
  const components = parseComponents(members, sources);

  return {
    version: 2,
    kind: "source-bundle",
    hashAlgorithm: "sha256",
    bundleHash,
    entrypoint,
    sources,
    ...(targetPath === undefined ? {} : { targetPath }),
    ...(components === undefined ? {} : { components }),
  };
}

/**
 * The complete closure, canonical.
 *
 * Exactly one entry per logical path, in the UTF-8 byte order of those paths.
 * The bundle hash commits to this array, so a descriptor that listed one path
 * twice over — or listed them in some other order — would be a second identity
 * for bytes that already have one.
 */
function parseSources(members: Members): readonly SourceBundleEntryV2[] {
  const path = "$.sources";
  const value = members.get("sources");
  if (!Array.isArray(value)) {
    throw fail(`expected an array, found ${describe(value)}`, path);
  }
  if (value.length === 0) {
    throw fail("expected at least one source", path);
  }

  const sources: SourceBundleEntryV2[] = [];
  let previous: Uint8Array | undefined;
  for (let index = 0; index < value.length; index++) {
    const entry = parseSourceEntry(value[index], `${path}[${index}]`);
    const bytes = encoder.encode(entry.path);
    if (previous !== undefined) {
      const order = compareBytes(previous, bytes);
      if (order === 0) {
        throw fail("expected each source path once", path);
      }
      if (order > 0) {
        throw fail("expected sources sorted by the UTF-8 bytes of their paths", path);
      }
    }
    previous = bytes;
    sources.push(entry);
  }
  return Object.freeze(sources);
}

function parseSourceEntry(value: unknown, path: string): SourceBundleEntryV2 {
  const members = parseMembers(value, path, fail);
  requireMemberNames(members, SOURCE_MEMBER_NAMES, path, fail);
  return {
    path: parseLogicalPath(parseStringMember(members, "path", path, fail), `${path}.path`),
    sourceHash: parseHash(
      parseStringMember(members, "sourceHash", path, fail),
      `${path}.sourceHash`,
    ),
    byteLength: parseByteLength(members.get("byteLength"), `${path}.byteLength`),
  };
}

/**
 * The bundle member the root resolves its component names through.
 *
 * Absence identifies a definition that declares no workflow components; an
 * empty array is not a second spelling of it and is refused. Every path names a
 * retained source, so the mapping is closed over the same bytes the run
 * executes rather than over something a later resolution would have to find.
 */
function parseComponents(
  members: Members,
  sources: readonly SourceBundleEntryV2[],
): readonly SourceBundleComponentV2[] | undefined {
  if (!members.has("components")) {
    return undefined;
  }
  const path = "$.components";
  const value = members.get("components");
  if (!Array.isArray(value)) {
    throw fail(`expected an array, found ${describe(value)}`, path);
  }
  if (value.length === 0) {
    throw fail("expected at least one component", path);
  }

  const paths = new Set(sources.map((source) => source.path));
  const components: SourceBundleComponentV2[] = [];
  let previous: Uint8Array | undefined;
  for (let index = 0; index < value.length; index++) {
    const entry = parseComponent(value[index], `${path}[${index}]`, paths);
    const bytes = encoder.encode(entry.name);
    if (previous !== undefined) {
      const order = compareBytes(previous, bytes);
      if (order === 0) {
        throw fail("expected each component name once", path);
      }
      if (order > 0) {
        throw fail("expected components sorted by the UTF-8 bytes of their names", path);
      }
    }
    previous = bytes;
    components.push(entry);
  }
  return Object.freeze(components);
}

function parseComponent(
  value: unknown,
  path: string,
  sourcePaths: ReadonlySet<string>,
): SourceBundleComponentV2 {
  const members = parseMembers(value, path, fail);
  requireMemberNames(members, COMPONENT_MEMBER_NAMES, path, fail);
  const name = parseStringMember(members, "name", path, fail);
  // Deliberately says nothing about the name it read. A declaration key is
  // authored text, and one that fails the grammar has not earned being printed.
  if (!isComponentName(name)) {
    throw fail("expected a component name", `${path}.name`);
  }
  const mapped = parseLogicalPath(parseStringMember(members, "path", path, fail), `${path}.path`);
  if (!sourcePaths.has(mapped)) {
    throw fail("expected a path this definition retains as a source", `${path}.path`);
  }
  return { name, path: mapped };
}

/** The one source the run begins at, which is Markdown by the name it has. */
function parseEntrypoint(value: string, sources: readonly SourceBundleEntryV2[]): string {
  const entrypoint = parseLogicalPath(value, "$.entrypoint");
  if (!entrypoint.endsWith(".md")) {
    throw fail('expected a ".md" path', "$.entrypoint");
  }
  if (!sources.some((source) => source.path === entrypoint)) {
    throw fail("expected a path this definition retains as a source", "$.entrypoint");
  }
  return entrypoint;
}

/**
 * The exact target this descriptor names, if it names one.
 *
 * Presence is the member being written at all, not its value: a descriptor that
 * wrote `targetPath` and gave it `undefined` or `null` asked for a target and
 * failed to say which, which is not the same as asking for the whole document.
 */
function parseTargetPath(members: Members): string | undefined {
  if (!members.has("targetPath")) {
    return undefined;
  }
  const path = "$.targetPath";
  const value = members.get("targetPath");
  if (typeof value !== "string") {
    throw fail(`expected a string, found ${describe(value)}`, path);
  }
  // Deliberately says nothing about the target it read: a canonical target
  // encodes heading text, and heading text is document content.
  if (!isCanonicalDocumentTarget(value)) {
    throw fail("expected one exact canonical document target", path);
  }
  return value;
}

/**
 * A portable name inside the bundle.
 *
 * Normalized rather than merely normalizable: two spellings of one path would
 * be two identities for one source, and NFC is the one form the descriptor
 * admits. The excluded characters are the ones that stop a logical path being
 * read back as itself — a separator the host would reinterpret, the fragment
 * delimiter a target uses, and the control characters a terminal acts on.
 */
function parseLogicalPath(value: string, path: string): string {
  if (value === "") {
    throw fail("expected a path", path);
  }
  // Asked before normalization: an unpaired surrogate is not a scalar value,
  // and encoding one substitutes U+FFFD, which would hash bytes nobody
  // supplied under a path nobody wrote.
  if (/\p{Surrogate}/u.test(value)) {
    throw fail("expected Unicode scalar values, found an unpaired surrogate", path);
  }
  if (value.normalize("NFC") !== value) {
    throw fail("expected an NFC-normalized path", path);
  }
  if (value.includes("\u0000")) {
    throw fail("expected a path without a NUL", path);
  }
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) {
      throw fail("expected a path without control characters", path);
    }
  }
  if (value.includes("\\")) {
    throw fail("expected POSIX separators, found a backslash", path);
  }
  if (value.includes("#")) {
    throw fail('expected a path without a "#"', path);
  }
  if (value.startsWith("/")) {
    throw fail("expected a bundle-relative path, found an absolute one", path);
  }
  if (value.endsWith("/")) {
    throw fail("expected a path, found a trailing separator", path);
  }
  for (const segment of value.split("/")) {
    if (segment === "") {
      throw fail("expected a normalized path, found an empty segment", path);
    }
    if (segment === "." || segment === "..") {
      throw fail(`expected a normalized path, found a ${JSON.stringify(segment)} segment`, path);
    }
  }
  return value;
}

/**
 * A hash is compared, never re-derived from its spelling, so the spelling is
 * the identity. One case is admitted so two hosts that agree about the bytes
 * also agree about the run.
 */
function parseHash(value: string, path: string): string {
  if (value.length !== HASH_DIGITS) {
    throw fail(`expected ${HASH_DIGITS} hexadecimal digits`, path);
  }
  if (!/^[0-9a-f]+$/.test(value)) {
    throw fail("expected lowercase hexadecimal digits", path);
  }
  return value;
}

/** How many bytes a source weighs: countable, and countable by this runtime. */
function parseByteLength(value: unknown, path: string): number {
  if (typeof value !== "number") {
    throw fail(`expected a number, found ${describe(value)}`, path);
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw fail("expected a non-negative safe integer", path);
  }
  return value;
}

/**
 * The descriptor as a plain JSON value.
 *
 * An interface has no index signature, so a descriptor is not a `Json` until it
 * is written out member by member. Doing that here is also what keeps the
 * stored shape and the parsed shape one decision.
 */
export function sourceBundleDefinitionToJson(definition: SourceBundleWorkflowDefinitionV2): Json {
  return {
    version: definition.version,
    kind: definition.kind,
    hashAlgorithm: definition.hashAlgorithm,
    bundleHash: definition.bundleHash,
    entrypoint: definition.entrypoint,
    sources: definition.sources.map((source) => ({
      path: source.path,
      sourceHash: source.sourceHash,
      byteLength: source.byteLength,
    })),
    // Written only when there is one. A descriptor that stored an explicit
    // absence would parse back as one that asked for a target, or for a bundle,
    // and failed to name it.
    ...(definition.targetPath === undefined ? {} : { targetPath: definition.targetPath }),
    ...(definition.components === undefined
      ? {}
      : {
          components: definition.components.map((component) => ({
            name: component.name,
            path: component.path,
          })),
        }),
  };
}

/** The component mapping this definition declares, empty when it declares none. */
export function sourceBundleComponents(
  definition: SourceBundleWorkflowDefinitionV2,
): readonly SourceBundleComponentV2[] {
  return definition.components ?? [];
}

/**
 * The hash of one source's exact bytes.
 *
 * Domain separated and length framed, so bytes that hash as a source cannot be
 * presented as any other structure this repository hashes, and so a source's
 * own length is committed to rather than inferred from where it ended.
 */
export function* sourceContentHash(bytes: Uint8Array): Operation<string> {
  return yield* digest([field(SOURCE_DOMAIN), u64(bytes.byteLength), bytes]);
}

/**
 * The hash of the closure a definition executes.
 *
 * Each source contributes its path, its decoded 32-byte hash and its length —
 * the decoded bytes rather than their hexadecimal text, so the hash commits to
 * the value and not to one spelling of it. The target is absent on purpose:
 * selecting a section does not change the bytes in the bundle.
 */
export function* sourceBundleHash(identity: SourceBundleIdentityV2): Operation<string> {
  const components = identity.components ?? [];
  const chunks: Uint8Array[] = [
    field(BUNDLE_DOMAIN),
    field(identity.entrypoint),
    u32(identity.sources.length),
  ];
  for (const source of identity.sources) {
    chunks.push(field(source.path), decodeHash(source.sourceHash), u64(source.byteLength));
  }
  chunks.push(u32(components.length));
  for (const component of components) {
    chunks.push(field(component.name), field(component.path));
  }
  return yield* digest(chunks);
}

/**
 * The definition, once its own hash is recomputed from what it retains.
 *
 * A descriptor that parses is well formed; this is the separate question of
 * whether it describes itself. Storage asks it before exposing a record,
 * because a bundle hash its own manifest does not produce is a retained
 * identity nobody can reproduce.
 */
export function* verifySourceBundleDefinition(
  definition: SourceBundleWorkflowDefinitionV2,
): Operation<Result<SourceBundleWorkflowDefinitionV2>> {
  const recomputed = yield* sourceBundleHash(definition);
  if (recomputed !== definition.bundleHash) {
    return Err(fail("expected the bundle hash this definition's sources produce", "$.bundleHash"));
  }
  return Ok(definition);
}

/**
 * The exact bytes offered for a definition, owned and checked against it.
 *
 * Copied before anything is checked, so what is verified is what is retained: a
 * caller holding the original `Uint8Array` can mutate it afterwards without
 * changing the run. The snapshot must name exactly the descriptor's paths in
 * exactly its order — a missing, extra or reordered entry describes a different
 * closure, not one to be repaired by sorting.
 */
export function* verifySourceBundleSnapshot(
  definition: SourceBundleWorkflowDefinitionV2,
  snapshot: unknown,
): Operation<Result<readonly SourceBundleSnapshotEntryV2[]>> {
  const owned = copySnapshot(snapshot);
  if (!owned.ok) {
    return owned;
  }

  const entries = owned.value;
  if (entries.length !== definition.sources.length) {
    return Err(new WorkflowRequestError(refusal("one entry per retained source")));
  }
  for (let index = 0; index < entries.length; index++) {
    const source = definition.sources[index];
    const entry = entries[index];
    if (entry.path !== source.path) {
      return Err(
        new WorkflowRequestError(refusal(`the retained source path at position ${index}`)),
      );
    }
    if (entry.bytes.byteLength !== source.byteLength) {
      return Err(
        new WorkflowRequestError(refusal(`the declared byte length at position ${index}`)),
      );
    }
    const hash = yield* sourceContentHash(entry.bytes);
    if (hash !== source.sourceHash) {
      return Err(
        new WorkflowRequestError(refusal(`the declared source hash at position ${index}`)),
      );
    }
  }

  // The bundle hash commits to the manifest the entries were just checked
  // against, and is recomputed anyway: a hash is not a reason to retain a
  // descriptor whose own structure disagrees with itself.
  const verified = yield* verifySourceBundleDefinition(definition);
  if (!verified.ok) {
    return verified;
  }
  return Ok(entries);
}

/**
 * The Markdown a retained source holds.
 *
 * Strict: a byte sequence that is not well-formed UTF-8 is refused rather than
 * decoded to replacement characters, because the replacement would parse as a
 * document the bundle hash does not describe. No normalization of any kind
 * happens here — the bytes stay authoritative, and this is only their reading.
 */
export function decodeSourceText(bytes: Uint8Array): Result<string> {
  try {
    return Ok(decoder.decode(bytes));
  } catch {
    return Err(new WorkflowRequestError("A workflow source must be well-formed UTF-8."));
  }
}

/** Names what disagreed, never the bytes, the path or the props involved. */
function refusal(subject: string): string {
  return (
    `The source snapshot offered for this workflow run does not match ${subject} its ` +
    "definition declares. Nothing was retained."
  );
}

function copySnapshot(value: unknown): Result<readonly SourceBundleSnapshotEntryV2[]> {
  if (!Array.isArray(value)) {
    return Err(new WorkflowRequestError(refusal("the array of sources")));
  }
  if (value.length === 0) {
    return Err(new WorkflowRequestError(refusal("the non-empty set of sources")));
  }

  const entries: SourceBundleSnapshotEntryV2[] = [];
  for (const candidate of value) {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
      return Err(new WorkflowRequestError(refusal("the shape of the entries")));
    }
    const members = new Map(Object.entries(candidate));
    for (const key of members.keys()) {
      if (!SNAPSHOT_MEMBER_NAMES.includes(key)) {
        return Err(new WorkflowRequestError(refusal("the members of the entries")));
      }
    }
    const path = members.get("path");
    const bytes = members.get("bytes");
    if (typeof path !== "string") {
      return Err(new WorkflowRequestError(refusal("the shape of the entries")));
    }
    if (!(bytes instanceof Uint8Array)) {
      return Err(new WorkflowRequestError(refusal("the shape of the entries")));
    }
    entries.push(Object.freeze({ path, bytes: Uint8Array.from(bytes) }));
  }
  return Ok(Object.freeze(entries));
}

function* digest(chunks: readonly Uint8Array[]): Operation<string> {
  const computed = yield* until(crypto.subtle.digest("SHA-256", concat(chunks)));
  return Array.from(new Uint8Array(computed), (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

function concat(chunks: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  let length = 0;
  for (const chunk of chunks) {
    length += chunk.byteLength;
  }
  const joined = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

/** `u32(utf8(value).length)` followed by those bytes. */
function field(value: string): Uint8Array {
  const bytes = encoder.encode(value);
  return concat([u32(bytes.byteLength), bytes]);
}

function u32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value);
  return bytes;
}

function u64(value: number): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(value));
  return bytes;
}

function decodeHash(value: string): Uint8Array {
  const bytes = new Uint8Array(HASH_BYTES);
  for (let index = 0; index < HASH_BYTES; index++) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

/** Two byte strings in UTF-8 order, which `<` on their strings is not. */
function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const shared = Math.min(left.byteLength, right.byteLength);
  for (let index = 0; index < shared; index++) {
    if (left[index] !== right[index]) {
      return left[index] < right[index] ? -1 : 1;
    }
  }
  if (left.byteLength === right.byteLength) {
    return 0;
  }
  return left.byteLength < right.byteLength ? -1 : 1;
}
