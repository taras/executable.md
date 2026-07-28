import { each } from "effection";
import type { Operation } from "effection";
import { exists, readTextFile, walk } from "@effectionx/fs";
import { listWorkspacePaths } from "./workspace.ts";

/** Discovery members that are not workspace entries. */
const EXTRA_MEMBERS = ["scripts"];

interface RootManifest {
  workspace: string[];
}

function parseWorkspace(source: string): RootManifest {
  return JSON.parse(source);
}

/**
 * Every test file in the repository, as sorted repository-relative POSIX paths.
 *
 * Walks each member's concrete `tests` directory rather than the repository
 * root. That is what keeps nested worktrees, `site`, and the deliberately
 * malformed `scripts/tests/fixtures` out without naming any of them.
 */
export function* listTestFiles(root: URL): Operation<string[]> {
  const { workspace } = parseWorkspace(yield* readTextFile(new URL("deno.json", root)));
  const members = [...(yield* listWorkspacePaths(workspace, root)), ...EXTRA_MEMBERS];

  const files: string[] = [];
  for (const member of members) {
    const tests = new URL(`${member}/tests/`, root);
    if (!(yield* exists(tests))) {
      continue;
    }
    const base = decodeURIComponent(tests.pathname);
    for (const entry of yield* each(
      walk(tests, { includeDirs: false, match: [/\.test\.ts$/], skip: [/node_modules/] }),
    )) {
      files.push(`${member}/tests/${relativeTo(base, entry.path)}`);
      yield* each.next();
    }
  }
  return files.sort();
}

/** `path` beneath `base`, as POSIX, whichever separator the host walked with. */
function relativeTo(base: string, path: string): string {
  const posix = path.replaceAll("\\", "/");
  const at = posix.indexOf(base);
  return at === -1 ? posix : posix.slice(at + base.length);
}
