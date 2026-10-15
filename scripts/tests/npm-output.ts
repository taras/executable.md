import { useTempDirectory } from "@executablemd/test-support/temp";
import { ensure, until } from "effection";
import type { Operation } from "effection";
import { cp, symlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE_ROOT = fileURLToPath(new URL("../../", import.meta.url));

export function* useNpmWorkspace(): Operation<string> {
  const root = yield* useTempDirectory("xmd-npm-workspace-");
  let preparing: Promise<unknown> = Promise.resolve();
  // Cancellation stops observing a copy, not the copy itself. Join it before the temporary
  // directory's owner removes the root, so it cannot recreate a released tree.
  yield* ensure(() =>
    until(
      preparing.then(
        () => undefined,
        () => undefined,
      ),
    ),
  );

  for (const entry of [
    "packages",
    "scripts",
    "smoke-test",
    "site",
    "deno.json",
    "deno.lock",
    "package.json",
    "LICENSE",
  ]) {
    preparing = cp(path.join(SOURCE_ROOT, entry), path.join(root, entry), {
      recursive: true,
      filter: (source) => !["npm", "node_modules", ".xmd-eval"].includes(path.basename(source)),
    });
    yield* until(preparing);
  }
  preparing = symlink(
    path.join(SOURCE_ROOT, "node_modules"),
    path.join(root, "node_modules"),
    "dir",
  );
  yield* until(preparing);
  return root;
}
