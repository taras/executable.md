/**
 * The Git identity of one Markdown source, derived from its own bytes.
 *
 * A workflow definition pins a commit and a path; it does not retain the
 * document. So a closure's blob identity is computed from the bytes somebody
 * read back out of that commit, and compared with it — which is what makes
 * "these are the bytes the definition names" a checkable claim rather than an
 * assertion by whoever did the reading.
 *
 * One function, because the exporter that produces a closure and the verifier
 * that admits one have to agree exactly. A second spelling would be a second
 * answer to the same question.
 */

import { createHash } from "node:crypto";
import type { Operation, Result } from "effection";
import type { Json } from "@executablemd/durable-streams";
import type { WorkflowDefinition } from "../storage/definition.ts";
import type { XmdArtifactDefinitionClosure } from "./types.ts";

const encoder = new TextEncoder();

/**
 * `sha1`/`sha256` of `blob <byte length>`, one NUL, then the content.
 *
 * The header is assembled from its own bytes rather than written as a string
 * literal: a NUL inside a source file makes that file binary to every tool that
 * reads a diff.
 */
export function gitBlobIdentity(content: string, objectFormat: "sha1" | "sha256"): string {
  const bytes = encoder.encode(content);
  return createHash(objectFormat)
    .update(encoder.encode(`blob ${bytes.byteLength}`))
    .update(new Uint8Array([0]))
    .update(bytes)
    .digest("hex");
}

/**
 * How one host turns a retained definition back into the Markdown it names.
 *
 * Installed into the lifecycle provider and captured in its closure — never
 * carried on a request and never reachable through a contextual name. That
 * distinction is the whole point: a closure travelling on the export request
 * would be source somebody handed in, and an artifact is supposed to be
 * evidence about a run rather than about whatever bytes its caller supplied.
 *
 * Reaching a repository is the host's business, so what the provider knows is
 * only that this returns a closure or says why it cannot.
 */
export type WorkflowDefinitionSourceReader = (
  definition: WorkflowDefinition,
  retrieval: Json | undefined,
) => Operation<Result<XmdArtifactDefinitionClosure>>;
