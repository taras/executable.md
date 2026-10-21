/**
 * The bundled Git Plugin, with this command's own entry-history admission.
 *
 * Git contributes the vocabulary and its two domain admissions. What an entry
 * retained about the checkout it was standing in is this command's record, so
 * the admission that reads it back belongs here — and it has to be *inside* the
 * contribution, because canonical core applies an admission within each
 * execution's own journal read.
 *
 * This wrapper is the one place that knows a `repl` request is different. Every
 * other command is delegated untouched, so the bundled Plugin keeps its name,
 * its deduplication and its place in the operator's own Plugin order.
 *
 * It is provider-neutral on purpose. The grammar an entry wrote down has to be
 * readable before any of it is replayed, on every runtime — a Node session that
 * retained nothing has nothing here to refuse, and nothing in this path reaches
 * the Deno adapter.
 */

import type { Operation } from "effection";
import type { Plugin, PluginInstallRequest, PluginInstallation } from "@executablemd/core/api";
import { gitCompositionInstallation } from "@executablemd/git";
import { admitReplRepositoryHistory } from "./admission.ts";

/** This command's assembly of one bundled Git Plugin. */
export function replRepositoryPlugin(bundled: Plugin): Plugin {
  return {
    ...bundled,
    *install(request: PluginInstallRequest): Operation<PluginInstallation | undefined> {
      if (request.command !== "repl") {
        const install = bundled.install;
        return install === undefined ? undefined : yield* install.call(bundled, request);
      }
      const contributed = yield* gitCompositionInstallation();
      return {
        ...contributed,
        admissions: [
          ...(contributed.admissions ?? []),
          (retained) => admitReplRepositoryHistory(retained),
        ],
      };
    },
  };
}
