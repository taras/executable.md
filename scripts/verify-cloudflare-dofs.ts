import { createHash } from "node:crypto";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const repositoryRoot = dirname(fileURLToPath(import.meta.url));
const root =
  Deno.args[0] === undefined
    ? join(repositoryRoot, "../packages/workflow/vendor/cloudflare-computer-dofs")
    : resolve(Deno.args[0]);
const manifestPath = join(root, "MANIFEST.json");

const expectedRepository = "https://github.com/cloudflare/computer";
const expectedCommit = "63d363632e558f7e077794988d36ed75017c2a62";

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

function walk(directory: string): string[] {
  const files: string[] = [];
  for (const entry of Deno.readDirSync(directory)) {
    const path = join(directory, entry.name);
    if (entry.isDirectory) {
      files.push(...walk(path));
    } else if (entry.isFile) {
      files.push(relative(root, path));
    } else {
      throw new Error(`vendored entry is not a regular file: ${relative(root, path)}`);
    }
  }
  return files.sort();
}

function loadManifest(): Manifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Deno.readTextFileSync(manifestPath));
  } catch (error) {
    throw new Error("Cloudflare DOFS manifest is unreadable", { cause: error });
  }
  return manifestSchema.parse(parsed);
}

function verifyInventory(manifest: Manifest): void {
  const recorded = manifest.files.map((file) => file.path);
  const duplicates = recorded.filter((path, index) => recorded.indexOf(path) !== index);
  if (duplicates.length > 0) {
    throw new Error(`duplicate vendored paths: ${[...new Set(duplicates)].join(", ")}`);
  }

  const expected = [...recorded, "MANIFEST.json"].sort();
  const actual = walk(root);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `vendored inventory differs\nexpected: ${expected.join("\n")}\nactual: ${actual.join("\n")}`,
    );
  }

  for (const file of manifest.files) {
    const actualDigest = digest(Deno.readFileSync(join(root, file.path)));
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

function emit(manifest: Manifest, output: string): void {
  const tsc = join(repositoryRoot, "../node_modules/typescript/bin/tsc");
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
    const message = new TextDecoder().decode(result.stderr);
    throw new Error(`vendored generated output did not compile\n${message}`);
  }
}

function verifyGenerated(manifest: Manifest): void {
  const temporary = Deno.makeTempDirSync({ dir: "/tmp", prefix: "xmd-dofs-vendor-" });
  try {
    emit(manifest, temporary);
    const actual = walkGenerated(temporary);
    const expected = generatedFiles(manifest);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(
        `generated inventory drifted\nexpected: ${expected.join("\n")}\nactual: ${actual.join("\n")}`,
      );
    }
    for (const path of expected) {
      const committed = Deno.readFileSync(join(root, "generated", path));
      const reproduced = Deno.readFileSync(join(temporary, path));
      if (digest(committed) !== digest(reproduced)) {
        throw new Error(`generated output drifted: generated/${path}`);
      }
    }
  } finally {
    Deno.removeSync(temporary, { recursive: true });
  }
}

function walkGenerated(directory: string): string[] {
  const files: string[] = [];
  for (const entry of Deno.readDirSync(directory)) {
    const path = join(directory, entry.name);
    if (entry.isDirectory) {
      for (const child of walkGenerated(path)) {
        files.push(join(entry.name, child));
      }
    } else if (entry.isFile) {
      files.push(entry.name);
    }
  }
  return files.sort();
}

const manifest = loadManifest();
verifyInventory(manifest);
verifyGenerated(manifest);
console.log(
  `verified Cloudflare Computer DOFS ${expectedCommit}: ${manifest.files.length} recorded files`,
);
