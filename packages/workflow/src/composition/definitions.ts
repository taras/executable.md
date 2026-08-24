/**
 * Where a composition component's definition comes from, for everyone who needs
 * one.
 *
 * `<Dir>` has two consumers. It is an ordinary registered default, and it is
 * the pinned lexical identity the generated-XMD write table admits
 * (specs/workflow-workspace-spec.md §8.4). A pinned identity built from a
 * second copy of the implementation or a second copy of the schema would be a
 * component nothing else in this package runs, and the drift would be invisible
 * until a generated fragment behaved differently from an authored one. So both
 * read this, and the generated evaluator never consults the registration.
 */

import type { FunctionComponentDefinition } from "@executablemd/core";
import Dir, { props as dirProps } from "./components/Dir.ts";

export const COMPOSITION_ORIGIN = "@executablemd/workflow/composition";

export function dirDefinition(): FunctionComponentDefinition {
  return { kind: "function", name: "Dir", props: dirProps, fn: Dir };
}
