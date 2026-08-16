import fs from "node:fs";
import * as filesystem from "node:fs";
import { mkdtempSync, readFileSync as readBytes } from "node:fs";
import type { Stats, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** A default import's members, one of them named by a string. */
export function copyThrough(from: string, to: string): void {
  const bytes = fs.readFileSync(from);
  fs.writeFileSync(to, bytes);
  fs["rmSync"](from, { force: true });
}

/** A namespace import's members, including one reached past the member itself. */
export function inspect(path: string): string {
  filesystem.accessSync(path);
  return filesystem.realpathSync.native(path);
}

/** A named import, and a named import under another name. */
export function scratch(prefix: string): Uint8Array {
  const directory = mkdtempSync(join("/tmp", prefix));
  return readBytes(join(directory, "seed"));
}

/** A type-only import binds no value. */
export function describe(info: Stats, reader: typeof statSync): number {
  return info.size + reader.length;
}

/** The asynchronous form is the destination, not the problem. */
export function contents(path: string): Promise<Buffer> {
  return readFile(path);
}

/** A local declaration of an imported name's spelling is a different function. */
function existsSync(path: string): boolean {
  return path.length > 0;
}

export function present(path: string): boolean {
  return existsSync(path);
}

/** So is a parameter that shadows one. */
export function shadowed(mkdtempSync: (prefix: string) => string): string {
  return mkdtempSync("shadow-");
}
