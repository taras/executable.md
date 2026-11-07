import { ComponentModuleLoader } from "@executablemd/core/api";
import { scoped } from "effection";
import type { Operation } from "effection";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { listTestFiles } from "../../../../scripts/lib/test-files.ts";
import { RUNTIMES } from "../../../../scripts/runtime-test-exclusions.ts";
import type { targetConfiguration, targetCorpus } from "./control.ts";
import { describe, read } from "./text-storage.ts";
import { verified } from "./admission.ts";

type Selection = z.infer<typeof targetConfiguration>;
type Corpus = z.infer<typeof targetCorpus>;

const record = z
  .object({ path: z.string().min(1), reason: z.string().min(1), issue: z.string().min(1) })
  .strict();
const selectedExport = z.object({
  exclusions: z
    .object({ deno: z.array(record), node: z.array(record), bun: z.array(record) })
    .strict(),
});

function root(repository: string): string {
  return repository.endsWith("/") ? repository : repository + "/";
}

/**
 * The selected target module's exact direct bytes, after proving they are the
 * regular tracked blob at the expected revision and equal its retained snapshot.
 * Nothing here evaluates the module.
 */
export function* selectedSource(
  repository: string,
  selection: Selection,
  tree: string,
  blob: string | null,
): Operation<string> {
  const [mode, type, object] = tree.trim().split(/\s+/);
  if (mode === undefined || tree.trim() === "") {
    throw new Error(
      "The target exclusion module " +
        selection.module.path +
        " is missing at the admitted revision. Commit an explicit deno/node/bun exclusions module before A; no workflow table or empty default is assumed.",
    );
  }
  if (mode !== "100644" || type !== "blob" || blob === null || blob.trim() !== object) {
    throw new Error(
      "The target exclusion module is not the regular tracked file at the admitted revision.",
    );
  }
  const source = yield* read(repository, selection.module.path);
  const observed = describe(selection.module.path, source);
  if (
    observed.utf8Bytes !== selection.module.utf8Bytes ||
    observed.sha256 !== selection.module.sha256 ||
    selection.snapshot.utf8Bytes !== selection.module.utf8Bytes ||
    selection.snapshot.sha256 !== selection.module.sha256
  ) {
    throw new Error("The target exclusion module differs from its selected bytes.");
  }
  if ((yield* verified(selection.snapshot, "The retained target exclusion snapshot")) !== source) {
    throw new Error("The retained target exclusion snapshot differs from the selected module.");
  }
  return source;
}

/**
 * Evaluate the selected trusted target configuration through the installed
 * module loader and return detached applicability data. Loading is owned by a
 * joined child scope, so its cleanup has finished before this returns.
 */
export function* targetApplicability(
  repository: string,
  selection: Selection,
  source: string,
): Operation<Corpus> {
  const selected = yield* ComponentModuleLoader.get();
  if (selected === undefined) {
    throw new Error(
      "No ComponentModuleLoader is installed, so the selected target exclusion module cannot be evaluated. Run admission under a host that installs one.",
    );
  }
  const load = selected.load.bind(selected);
  const origin = pathToFileURL(root(repository) + selection.module.path).href;
  const excluded = yield* scoped(function* () {
    const parsed = selectedExport.safeParse(yield* load(source, origin));
    if (!parsed.success) {
      throw new Error(
        "The target exclusion module must export exclusions with deno, node and bun arrays of {path, reason, issue} records: " +
          parsed.error.message,
      );
    }
    return {
      deno: parsed.data.exclusions.deno.map((entry) => entry.path),
      node: parsed.data.exclusions.node.map((entry) => entry.path),
      bun: parsed.data.exclusions.bun.map((entry) => entry.path),
    };
  });
  const discovered = yield* listTestFiles(pathToFileURL(root(repository)));
  const applicable: Corpus["applicable"] = { deno: [], node: [], bun: [] };
  for (const runtime of RUNTIMES) {
    const skip = new Set(excluded[runtime]);
    applicable[runtime] = discovered.filter((file) => !skip.has(file));
  }
  return { discovered, applicable };
}
