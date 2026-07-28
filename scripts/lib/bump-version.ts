import { readTextFile, writeTextFile } from "@effectionx/fs";
import type { Operation } from "effection";
import { z } from "zod";
import { listWorkspacePaths } from "./workspace.ts";

const SCOPE = "@executablemd/";

const RootSchema = z.object({ workspace: z.array(z.string()) });
const NamedSchema = z.object({ name: z.string() });
const VERSION_FIELD = /"version": "[^"]+"/;

/**
 * Stamp `version` into the `deno.json` and `package.json` of every
 * `@executablemd` member of the workspace rooted at `repoRoot`, and return the
 * root-relative paths written. Nothing outside those manifests is touched.
 */
export function* bumpManifests(version: string, repoRoot: URL): Operation<string[]> {
  const root = RootSchema.parse(JSON.parse(yield* readTextFile(new URL("deno.json", repoRoot))));
  const stamped: string[] = [];

  for (const dir of yield* listWorkspacePaths(root.workspace, repoRoot)) {
    let denoText: string;
    try {
      denoText = yield* readTextFile(new URL(`${dir}/deno.json`, repoRoot));
    } catch {
      continue;
    }
    const named = NamedSchema.safeParse(JSON.parse(denoText));
    if (!named.success || !named.data.name.startsWith(SCOPE)) {
      continue;
    }
    for (const manifest of ["deno.json", "package.json"]) {
      const relative = `${dir}/${manifest}`;
      const url = new URL(relative, repoRoot);
      const text = yield* readTextFile(url);
      // Matched rather than compared: restamping the version a manifest already
      // declares is a no-op write, not a missing field.
      if (!VERSION_FIELD.test(text)) {
        throw new Error(`no version field found in ${relative}`);
      }
      yield* writeTextFile(url, text.replace(VERSION_FIELD, `"version": "${version}"`));
      stamped.push(relative);
    }
  }

  return stamped;
}
