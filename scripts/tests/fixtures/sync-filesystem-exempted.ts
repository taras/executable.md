/* oxlint-disable local/no-sync-filesystem */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A file-wide directive covers every call below it and states no invariant for
 * any of them, which is why the repository forbids the form.
 */
export function stage(root: string, files: string[]): void {
  mkdirSync(root, { recursive: true });

  for (const file of files) {
    writeFileSync(join(root, file), readFileSync(file));
  }
}
