/**
 * Evaluate generated module text and hand back what it exports.
 *
 * Asserting on the text alone cannot show that the text is a module: an escape
 * the serializer got wrong is a string comparison away from looking right and a
 * parse away from being wrong. So the text is written to a scratch file and
 * imported, and the assertions run against the values the runtime produced.
 *
 * `extension` is what decides which parser sees the text — `.ts` proves it is
 * valid TypeScript, `.mjs` proves it is a valid ECMAScript module under every
 * runtime that can load one.
 */
import { ensure, until } from "effection";
import type { Operation } from "effection";
import { rm, writeTextFile } from "@effectionx/fs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export interface GeneratedModule {
  clientJs: string;
  themeCss: string;
  clientJsBytes: number;
  themeCssBytes: number;
}

/** The scratch file is removed when the calling operation shuts down, however it exits. */
export function* loadGeneratedModule(
  source: string,
  extension: ".ts" | ".mjs",
): Operation<GeneratedModule> {
  // @effectionx/fs has no mkdtemp.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "client-bundle-"));
  yield* ensure(() => rm(base, { recursive: true, force: true }));

  const module = new URL(`client-bundle${extension}`, pathToFileURL(`${base}/`));
  yield* writeTextFile(module, source);

  const loaded: GeneratedModule = yield* until(import(module.href));
  return loaded;
}
