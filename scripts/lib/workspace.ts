import { readdir } from "@effectionx/fs";
import type { Operation } from "effection";

export function* listWorkspacePaths(entries: string[], root: URL): Operation<string[]> {
  const dirs: string[] = [];
  for (const entry of entries) {
    if (entry.endsWith("/*")) {
      const parent = entry.slice(0, -2);
      // Sorted so the listing does not depend on directory-read order.
      for (const name of (yield* readdir(new URL(`${parent}/`, root))).sort()) {
        dirs.push(`${parent}/${name}`);
      }
    } else {
      dirs.push(entry);
    }
  }
  return dirs;
}
