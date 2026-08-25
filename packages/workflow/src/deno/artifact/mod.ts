/**
 * @module
 *
 * The XMD artifact container, as the rest of the Deno provider sees it.
 *
 * Two operations and the values they exchange. The private SQLite encoding —
 * its marker, its tables, its SQL, its connections and its rows — stays behind
 * this barrel and is never re-exported past the provider, because `.xmd` and
 * the versioned semantic contract are the public compatibility boundary and a
 * table name that leaked into an entrypoint would become one too.
 */

export { readXmdArtifact } from "./read.ts";
export { writeXmdArtifact } from "./write.ts";
export type {
  DetachedXmdArtifact,
  VerifiedXmdArtifact,
  XmdArtifactDefinitionClosure,
  XmdArtifactDefinitionComponent,
  XmdArtifactDefinitionRoot,
  XmdArtifactForkLineage,
  XmdArtifactFrontier,
  XmdArtifactJournalRow,
  XmdArtifactWriteResult,
} from "./types.ts";
