/**
 * Components core owns (specs/executable-mdx-spec.md §5.3).
 *
 * A built-in resolves no source file: it is already in the module graph, so it
 * ships in the compiled binary and every published package without a search
 * path or a bundling step. Import consults this map and returns the definition
 * directly.
 *
 * Deliberately module-private — not exported from `mod.ts`. What is contracted
 * is only that a built-in resolves with no path and no search directory; where
 * this lookup sits relative to filesystem resolution is incidental and may
 * change. What a host may add, what happens when a repository file shares one
 * of these names, and how inspection reports the choice are #202's to settle.
 */

import type { FunctionComponentDefinition } from "../types.ts";
import TempDir, { props as tempDirProps } from "./TempDir.ts";
import { parseJsonObject } from "../json.ts";

const BUILT_IN: ReadonlyMap<string, FunctionComponentDefinition> = new Map<
  string,
  FunctionComponentDefinition
>([
  [
    "TempDir",
    {
      kind: "function",
      name: "TempDir",
      path: "<built-in>/TempDir",
      props: parseJsonObject(tempDirProps),
      fn: TempDir,
    },
  ],
]);

export function builtInComponent(name: string): FunctionComponentDefinition | undefined {
  return BUILT_IN.get(name);
}
