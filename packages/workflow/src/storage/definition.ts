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
import { isCanonicalDocumentTarget } from "@executablemd/core";
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

/** Every descriptor this build understands. */
export type WorkflowDefinition = GitWorkflowDefinitionV1;

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
  requireMemberNames(members, MEMBER_NAMES, "$", fail);

  const version = members.get("version");
  if (version !== 1) {
    throw fail("expected version 1", "$.version");
  }

  const kind = parseStringMember(members, "kind", "$", fail);
  if (kind !== "git") {
    throw fail('expected the kind "git"', "$.kind");
  }

  const objectFormat = parseObjectFormat(members.get("objectFormat"));
  const targetPath = parseTargetPath(members);

  return {
    version: 1,
    kind: "git",
    objectFormat,
    objectId: parseObjectId(parseStringMember(members, "objectId", "$", fail), objectFormat),
    rootDocumentPath: parseRootDocumentPath(
      parseStringMember(members, "rootDocumentPath", "$", fail),
    ),
    ...(targetPath === undefined ? {} : { targetPath }),
  };
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
  };
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
  const length = OBJECT_ID_LENGTHS[format];
  if (value.length !== length) {
    throw fail(`expected ${length} hexadecimal digits for ${format}`, "$.objectId");
  }
  if (!/^[0-9a-f]+$/.test(value)) {
    throw fail("expected lowercase hexadecimal digits", "$.objectId");
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
  const path = "$.rootDocumentPath";
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
