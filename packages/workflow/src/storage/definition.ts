/**
 * What a workflow run is a run *of*.
 *
 * The definition descriptor is the run's immutable identity: the object that
 * holds the document and the path to the document within it. It is supplied by
 * the host, stored once, and compared on every compatible reuse of a run id.
 *
 * Retrieval is deliberately not part of it. Where a repository can be fetched
 * from, and where it happens to be checked out on this machine, change without
 * changing which document ran — so a locator is replaceable metadata rather
 * than identity, and a run stays the same run when it moves between hosts.
 *
 * The descriptor carries its own `version`. A later version is a different
 * identity rather than the same one read loosely, which is why the version
 * takes part in the comparison instead of governing it.
 */

import { Err, Ok, type Result } from "effection";
import { isCanonicalDocumentTarget, isComponentName } from "@executablemd/core";
import type { Json } from "@executablemd/durable-streams";
import { WorkflowDefinitionError } from "./errors.ts";
import {
  describe,
  type Members,
  parseMembers,
  parseStringMember,
  requireMemberNames,
} from "./members.ts";

/**
 * A document at a path inside one immutable Git object, optionally projected to
 * one of its sections.
 *
 * `targetPath` is the *resolved exact* canonical document target, never the
 * selector a caller wrote: two callers may spell one request differently, and a
 * glob re-resolved against a different checkout would name a different section.
 * Absent, it identifies the whole document — which is what a whole-document
 * workflow is, not a legacy spelling of a targeted one.
 */
export interface GitWorkflowDefinitionV1 {
  readonly version: 1;
  readonly kind: "git";
  readonly objectFormat: "sha1" | "sha256";
  readonly objectId: string;
  readonly rootDocumentPath: string;
  /** One exact canonical document target, without a leading `#`. */
  readonly targetPath?: string;
}

/**
 * One authored component the workflow definition is closed over.
 *
 * `path` is the canonical repository-relative POSIX path of the Markdown blob
 * inside the same pinned commit the root came from — never the `./Name.md` a
 * root wrote. `sourceHash` is that blob's own object id under the descriptor's
 * `objectFormat`, so changing what a component says changes the definition
 * rather than changing what a retained definition executes.
 */
export interface WorkflowComponentEntry {
  readonly name: string;
  readonly path: string;
  readonly sourceHash: string;
}

/**
 * A definition that is closed over a bundle of authored components.
 *
 * Everything V1 identifies, plus the exact set of components the root may
 * resolve. The array is the durable identity view of that bundle: sorted by
 * component name, so one bundle has one spelling, and compared whole, so a
 * changed name, path, or source is a different definition rather than the same
 * one running different code.
 *
 * V1 is not this descriptor with an empty array. A run with no bundle is a V1
 * run and stays byte-for-byte what it always was.
 */
export interface GitWorkflowDefinitionV2 {
  readonly version: 2;
  readonly kind: "git";
  readonly objectFormat: "sha1" | "sha256";
  readonly objectId: string;
  readonly rootDocumentPath: string;
  /** One exact canonical document target, without a leading `#`. */
  readonly targetPath?: string;
  readonly components: readonly WorkflowComponentEntry[];
}

/** Every descriptor this build understands. */
export type WorkflowDefinition = GitWorkflowDefinitionV1 | GitWorkflowDefinitionV2;

/** Hexadecimal digits per object id, by the format that names them. */
const OBJECT_ID_LENGTHS: Readonly<Record<GitWorkflowDefinitionV1["objectFormat"], number>> = {
  sha1: 40,
  sha256: 64,
};

const MEMBER_NAMES = [
  "version",
  "kind",
  "objectFormat",
  "objectId",
  "rootDocumentPath",
  "targetPath",
];

const V2_MEMBER_NAMES = [...MEMBER_NAMES, "components"];

const COMPONENT_MEMBER_NAMES = ["name", "path", "sourceHash"];

function fail(reason: string, path: string): Error {
  return new WorkflowDefinitionError(reason, path);
}

/**
 * The workflow definition a value describes.
 *
 * Parsed rather than asserted: a descriptor reaches storage from a host, and a
 * host that builds one by hand — or reads one from a file — can build one that
 * type-checks and does not describe a definition.
 */
export function parseWorkflowDefinition(value: unknown): Result<WorkflowDefinition> {
  try {
    return Ok(parseDefinition(value));
  } catch (error) {
    if (error instanceof WorkflowDefinitionError) {
      return Err(error);
    }
    throw error;
  }
}

function parseDefinition(value: unknown): WorkflowDefinition {
  const members = parseMembers(value, "$", fail);

  const version = members.get("version");
  if (version !== 1 && version !== 2) {
    throw fail("expected version 1 or 2", "$.version");
  }
  // Each version declares its own members. A V1 descriptor carrying a bundle
  // and a V2 descriptor missing one are both refused here rather than being
  // read as the other version with a field dropped or defaulted.
  requireMemberNames(members, version === 1 ? MEMBER_NAMES : V2_MEMBER_NAMES, "$", fail);

  const kind = parseStringMember(members, "kind", "$", fail);
  if (kind !== "git") {
    throw fail('expected the kind "git"', "$.kind");
  }

  const objectFormat = parseObjectFormat(members.get("objectFormat"));
  const targetPath = parseTargetPath(members);
  const common = {
    kind: "git",
    objectFormat,
    objectId: parseObjectId(parseStringMember(members, "objectId", "$", fail), objectFormat),
    rootDocumentPath: parseRootDocumentPath(
      parseStringMember(members, "rootDocumentPath", "$", fail),
    ),
    ...(targetPath === undefined ? {} : { targetPath }),
  } as const;

  if (version === 1) {
    return { version: 1, ...common };
  }
  return {
    version: 2,
    ...common,
    components: parseComponents(members.get("components"), objectFormat),
  };
}

/**
 * The bundle a V2 descriptor is closed over.
 *
 * Canonical rather than merely valid: exactly one entry per name, in
 * lexicographic order by name. A descriptor that lists the same bundle twice
 * over would otherwise be two identities for one run, and compatible reuse
 * compares this array whole.
 */
function parseComponents(
  value: unknown,
  format: GitWorkflowDefinitionV2["objectFormat"],
): readonly WorkflowComponentEntry[] {
  const path = "$.components";
  if (!Array.isArray(value)) {
    throw fail(`expected an array, found ${describe(value)}`, path);
  }
  if (value.length === 0) {
    throw fail("expected at least one component", path);
  }

  const components: WorkflowComponentEntry[] = [];
  let previous: string | undefined;
  for (let index = 0; index < value.length; index++) {
    const entry = parseComponent(value[index], `${path}[${index}]`, format);
    if (previous !== undefined && !(previous < entry.name)) {
      throw fail(
        previous === entry.name
          ? "expected each component name once"
          : "expected components sorted by name",
        path,
      );
    }
    previous = entry.name;
    components.push(entry);
  }
  return Object.freeze(components);
}

function parseComponent(
  value: unknown,
  path: string,
  format: GitWorkflowDefinitionV2["objectFormat"],
): WorkflowComponentEntry {
  const members = parseMembers(value, path, fail);
  requireMemberNames(members, COMPONENT_MEMBER_NAMES, path, fail);
  const name = parseStringMember(members, "name", path, fail);
  // Deliberately says nothing about the name it read. A declaration key is
  // authored text, and one that fails the grammar has not earned being printed.
  if (!isComponentName(name)) {
    throw fail("expected a component name", `${path}.name`);
  }
  return {
    name,
    path: parseComponentPath(parseStringMember(members, "path", path, fail), `${path}.path`),
    sourceHash: parseObjectIdAt(
      parseStringMember(members, "sourceHash", path, fail),
      format,
      `${path}.sourceHash`,
    ),
  };
}

/**
 * A component's path inside the pinned tree.
 *
 * The root document's rules, plus the one extension a bundled component may
 * have: a bundle member is Markdown the engine parses, so a `.ts` module or an
 * extensionless path names something this descriptor cannot describe.
 */
function parseComponentPath(value: string, path: string): string {
  const normalized = parsePathAt(value, path);
  if (!normalized.endsWith(".md")) {
    throw fail('expected a ".md" path', path);
  }
  return normalized;
}

/**
 * The exact target this descriptor names, if it names one.
 *
 * Presence is the member being written at all, not its value: a descriptor that
 * wrote `targetPath` and gave it `undefined` or `null` asked for a target and
 * failed to say which, which is not the same as asking for the whole document.
 *
 * What counts as canonical is core's own predicate, not a rule restated here.
 * Identity that two packages define separately is identity they can disagree
 * about, and this member is compared against targets the document layer
 * produced.
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
 * The descriptor as a plain JSON value.
 *
 * An interface has no index signature, so a descriptor is not a `Json` until
 * it is written out member by member. Doing that here is also what keeps the
 * stored shape and the parsed shape one decision.
 */
export function definitionToJson(definition: WorkflowDefinition): Json {
  return {
    version: definition.version,
    kind: definition.kind,
    objectFormat: definition.objectFormat,
    objectId: definition.objectId,
    rootDocumentPath: definition.rootDocumentPath,
    // Written only when there is one. An untargeted definition that stored an
    // explicit absence would parse back as a descriptor that asked for a target
    // and failed to name it.
    ...(definition.targetPath === undefined ? {} : { targetPath: definition.targetPath }),
    // Same rule for the bundle: a V1 descriptor writes no `components` member
    // at all, so what a no-bundle run stored before this version existed is
    // byte for byte what it stores now.
    ...(definition.version === 2
      ? {
          components: definition.components.map((component) => ({
            name: component.name,
            path: component.path,
            sourceHash: component.sourceHash,
          })),
        }
      : {}),
  };
}

/** The bundle this definition is closed over, empty when it is closed over none. */
export function definitionComponents(
  definition: WorkflowDefinition,
): readonly WorkflowComponentEntry[] {
  return definition.version === 2 ? definition.components : [];
}

function parseObjectFormat(value: unknown): GitWorkflowDefinitionV1["objectFormat"] {
  if (value === "sha1" || value === "sha256") {
    return value;
  }
  throw fail(`expected "sha1" or "sha256", found ${describe(value)}`, "$.objectFormat");
}

/**
 * An object id is compared, never re-derived, so its spelling is the identity.
 *
 * Uppercase hexadecimal names the same object and is a different string. One
 * spelling is admitted so two hosts that agree about the commit also agree
 * about the run.
 */
function parseObjectId(value: string, format: GitWorkflowDefinitionV1["objectFormat"]): string {
  return parseObjectIdAt(value, format, "$.objectId");
}

function parseObjectIdAt(
  value: string,
  format: GitWorkflowDefinitionV1["objectFormat"],
  path: string,
): string {
  const length = OBJECT_ID_LENGTHS[format];
  if (value.length !== length) {
    throw fail(`expected ${length} hexadecimal digits for ${format}`, path);
  }
  if (!/^[0-9a-f]+$/.test(value)) {
    throw fail("expected lowercase hexadecimal digits", path);
  }
  return value;
}

/**
 * A repository-relative POSIX path, already normalized.
 *
 * Storage neither normalizes nor resolves: two spellings of one path would
 * otherwise be two identities, and a path that escapes its repository would be
 * stored as identity and later handed to something that opens it.
 */
function parseRootDocumentPath(value: string): string {
  return parsePathAt(value, "$.rootDocumentPath");
}

function parsePathAt(value: string, path: string): string {
  if (value === "") {
    throw fail("expected a path", path);
  }
  if (value.includes("\u0000")) {
    throw fail("expected a path without a NUL", path);
  }
  if (value.includes("\\")) {
    throw fail("expected POSIX separators, found a backslash", path);
  }
  if (value.startsWith("/")) {
    throw fail("expected a repository-relative path, found an absolute one", path);
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
