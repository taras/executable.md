import { lstat, readdir, readTextFile } from "@effectionx/fs";
import { main, until } from "effection";
import type { Operation } from "effection";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { useTempDirectory } from "./lib/temp-directory.ts";
import { z } from "zod";

const repositoryRoot = dirname(fileURLToPath(import.meta.url));
const root =
  Deno.args[0] === undefined
    ? join(repositoryRoot, "../packages/workflow/vendor/cloudflare-computer-dofs")
    : resolve(Deno.args[0]);
const manifestPath = join(root, "MANIFEST.json");

const expectedRepository = "https://github.com/cloudflare/computer";
const expectedCommit = "63d363632e558f7e077794988d36ed75017c2a62";
const decoder = new TextDecoder();

const manifestSchema = z.object({
  format: z.literal(1),
  repository: z.literal(expectedRepository),
  commit: z.literal(expectedCommit),
  compiler: z.string().min(1),
  files: z.array(
    z.object({
      path: z.string().min(1),
      kind: z.enum(["license", "provenance", "upstream", "generated"]),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
    }),
  ),
});

type Manifest = z.infer<typeof manifestSchema>;

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function* walk(directory: string): Operation<string[]> {
  const files: string[] = [];
  for (const name of yield* readdir(directory)) {
    const path = join(directory, name);
    const info = yield* lstat(path);
    if (info.isDirectory()) {
      files.push(...(yield* walk(path)));
    } else if (info.isFile()) {
      files.push(relative(root, path));
    } else {
      throw new Error(`vendored entry is not a regular file: ${relative(root, path)}`);
    }
  }
  return files.sort();
}

function* loadManifest(): Operation<Manifest> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(yield* readTextFile(manifestPath));
  } catch (error) {
    throw new Error("Cloudflare DOFS manifest is unreadable", { cause: error });
  }
  return manifestSchema.parse(parsed);
}

function* verifyInventory(manifest: Manifest): Operation<void> {
  const recorded = manifest.files.map((file) => file.path);
  const duplicates = recorded.filter((path, index) => recorded.indexOf(path) !== index);
  if (duplicates.length > 0) {
    throw new Error(`duplicate vendored paths: ${[...new Set(duplicates)].join(", ")}`);
  }

  const expected = [...recorded, "MANIFEST.json"].sort();
  const actual = yield* walk(root);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `vendored inventory differs\nexpected: ${expected.join("\n")}\nactual: ${actual.join("\n")}`,
    );
  }

  for (const file of manifest.files) {
    const actualDigest = digest(yield* until(readFile(join(root, file.path))));
    if (actualDigest !== file.sha256) {
      throw new Error(
        `vendored file changed: ${file.path}\nexpected ${file.sha256}\nactual   ${actualDigest}`,
      );
    }
  }
}

function sourceFiles(manifest: Manifest): string[] {
  return manifest.files
    .filter((file) => file.kind === "upstream")
    .map((file) => join(root, file.path));
}

function generatedFiles(manifest: Manifest): string[] {
  return manifest.files
    .filter((file) => file.kind === "generated")
    .map((file) => file.path.slice("generated/".length))
    .sort();
}

function compilerVersion(tsc: string): string {
  const command = new Deno.Command(Deno.execPath(), {
    cwd: join(repositoryRoot, ".."),
    args: ["run", "--allow-read", "--allow-env", tsc, "--version"],
    stdout: "piped",
    stderr: "piped",
  });
  const result = command.outputSync();
  if (!result.success) {
    throw new Error(
      `installed TypeScript compiler did not report its version\n${decoder.decode(result.stderr)}`,
    );
  }
  const output = decoder.decode(result.stdout).trim();
  const match = /^Version (\S+)$/.exec(output);
  if (match === null) {
    throw new Error(`installed TypeScript compiler reported an unrecognized version: ${output}`);
  }
  return match[1];
}

function verifiedCompiler(manifest: Manifest): string {
  const tsc = join(repositoryRoot, "../node_modules/typescript/bin/tsc");
  const installed = compilerVersion(tsc);
  if (installed !== manifest.compiler) {
    throw new Error(
      `TypeScript compiler provenance mismatch\nmanifest:  ${manifest.compiler}\ninstalled: ${installed}`,
    );
  }
  return tsc;
}

function emit(manifest: Manifest, output: string, tsc: string): void {
  const command = new Deno.Command(Deno.execPath(), {
    cwd: join(repositoryRoot, ".."),
    args: [
      "run",
      "--allow-read",
      `--allow-write=${output}`,
      "--allow-env",
      tsc,
      "--target",
      "ES2022",
      "--module",
      "ES2022",
      "--moduleResolution",
      "bundler",
      "--lib",
      "ES2023,WebWorker",
      "--strict",
      "--skipLibCheck",
      "--noEmit",
      "false",
      "--declaration",
      "true",
      "--rootDir",
      join(root, "upstream/src"),
      "--outDir",
      output,
      ...sourceFiles(manifest),
    ],
    stdout: "piped",
    stderr: "piped",
  });
  const result = command.outputSync();
  if (!result.success) {
    const message = decoder.decode(result.stderr);
    throw new Error(`vendored generated output did not compile\n${message}`);
  }
}

function* verifyGenerated(manifest: Manifest, tsc: string): Operation<void> {
  // Under /tmp, because the task grants write to that path alone.
  const temporary = yield* useTempDirectory("xmd-dofs-vendor-", { dir: "/tmp" });

  emit(manifest, temporary, tsc);
  const actual = yield* walkGenerated(temporary);
  const expected = generatedFiles(manifest);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `generated inventory drifted\nexpected: ${expected.join("\n")}\nactual: ${actual.join("\n")}`,
    );
  }
  for (const path of expected) {
    const committed = yield* until(readFile(join(root, "generated", path)));
    const reproduced = yield* until(readFile(join(temporary, path)));
    if (digest(committed) !== digest(reproduced)) {
      throw new Error(`generated output drifted: generated/${path}`);
    }
  }
}

function* walkGenerated(directory: string): Operation<string[]> {
  const files: string[] = [];
  for (const name of yield* readdir(directory)) {
    const path = join(directory, name);
    const info = yield* lstat(path);
    if (info.isDirectory()) {
      for (const child of yield* walkGenerated(path)) {
        files.push(join(name, child));
      }
    } else if (info.isFile()) {
      files.push(name);
    }
  }
  return files.sort();
}

await main(function* () {
  const manifest = yield* loadManifest();
  yield* verifyInventory(manifest);
  const tsc = verifiedCompiler(manifest);
  yield* verifyGenerated(manifest, tsc);
  console.log(
    `verified Cloudflare Computer DOFS ${expectedCommit}: ${manifest.files.length} recorded files; regenerated with TypeScript ${manifest.compiler}`,
  );
});
