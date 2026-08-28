/**
 * @module
 *
 * The ACP adapters this build carries, and how a host puts one on disk.
 *
 * Its own entrypoint, and deliberately not part of `@executablemd/acp`. This is
 * a temporary arrangement: no published Codex or Claude release names the turn
 * a Prompt completed, so a workflow run executes the snapshots under
 * `vendor/adapters` instead. Issue #636 removes them, one provider at a time,
 * as qualifying releases appear.
 *
 * Anything on the package root is a stable contract somebody may build on, and
 * withdrawing one is a compatibility break. A workaround should not be able to
 * earn that, so it lives here and goes away with the thing it exists for.
 *
 * The workflow Agent profile is the only caller.
 */

export {
  AdapterSnapshotError,
  carriesEmbeddedAdapter,
  createEmbeddedAdapters,
  embeddedAdapterIdentities,
  overlaidAdapterRegistry,
} from "./src/adapter-snapshots.ts";
export type { EmbeddedAdapters, EmbeddedAdapterSnapshot } from "./src/adapter-snapshots.ts";
