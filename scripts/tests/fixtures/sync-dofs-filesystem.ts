import { readRangeSync } from "../../../packages/workflow/vendor/cloudflare-computer-dofs/generated/fs/readFile.js";
import { writeFileSync } from "../../../packages/workflow/vendor/cloudflare-computer-dofs/generated/fs/writeFile.js";
import { readFileSync } from "./example-sync.ts";

/** The repository's own synchronous filesystem, recognized by module and export. */
export function through(dofs: unknown, path: string, bytes: Uint8Array, now: number): Uint8Array {
  writeFileSync(dofs, path, bytes, {}, now);
  return new Uint8Array(readRangeSync(dofs, path, 0, bytes.length));
}

/** The same spelling exported by a module that is not a filesystem. */
export function decoy(path: string): string {
  return readFileSync(path);
}
