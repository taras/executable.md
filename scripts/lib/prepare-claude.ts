import { action, ensure, scoped, until, useAbortSignal } from "effection";
import type { Operation } from "effection";
import { exec } from "@effectionx/process";
import { ensureDir, exists, readTextFile } from "@effectionx/fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import tar from "tar-stream";
import { z } from "zod";
import { ClaudeRecipe, recipeInputsSha256 } from "./claude-recipe.ts";
import { claudeSnapshotModule, gzipStored, sha256 } from "./claude-snapshot-module.ts";
import { useTempDirectory } from "./temp-directory.ts";
import { replaceThroughStaging } from "./staged-write.ts";

export const CLAUDE_RECIPE = "packages/acp/vendor/adapters/claude/recipe.json";
export const CLAUDE_OUTPUT = "packages/acp/generated/claude-snapshot.ts";
const VENDOR = "packages/acp/vendor/adapters/claude/";

export function verifyHash(name: string, bytes: Uint8Array | string, expected: string): void {
  const actual = sha256(bytes);
  if (actual !== expected) {
    throw new Error(`${name}: expected SHA-256 ${expected}, actual ${actual}`);
  }
}

export interface ClaudeMember {
  path: string;
  bytes: Uint8Array;
}

export function packClaude(members: readonly ClaudeMember[]): Operation<Uint8Array> {
  return action((resolve, reject) => {
    const pack = tar.pack();
    const chunks: Buffer[] = [];
    const onData = (chunk: Buffer): void => {
      chunks.push(chunk);
    };
    const onEnd = (): void => {
      resolve(gzipStored(Buffer.concat(chunks)));
    };
    const onError = (error: Error): void => {
      reject(error);
    };
    pack.on("data", onData);
    pack.on("end", onEnd);
    pack.on("error", onError);
    try {
      const names = new Set<string>();
      for (const member of [...members].sort((a, b) =>
        a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
      )) {
        if (
          !/^[a-zA-Z0-9_.\/-]+$/.test(member.path) ||
          member.path.split("/").includes("..") ||
          member.path.startsWith("/") ||
          names.has(member.path)
        ) {
          throw new Error(`Unexpected Claude member: ${member.path}`);
        }
        names.add(member.path);
        pack.entry(
          {
            name: `package/${member.path}`,
            type: "file",
            size: member.bytes.length,
            mode: member.path === "dist/index.js" ? 0o755 : 0o644,
            uid: 0,
            gid: 0,
            uname: "",
            gname: "",
            mtime: new Date(0),
          },
          Buffer.from(member.bytes),
        );
      }
      pack.finalize();
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
    }
    return () => {
      pack.off("data", onData);
      pack.off("end", onEnd);
      pack.off("error", onError);
      pack.destroy();
    };
  });
}

export function* downloadClaudeInput(pin: {
  url: string;
  sha256: string;
  bytes: number;
}): Operation<Uint8Array> {
  const signal = yield* useAbortSignal();
  const response = yield* until(fetch(pin.url, { signal }));
  if (!response.ok) {
    throw new Error(`${pin.url}: HTTP ${response.status}`);
  }
  const bytes = new Uint8Array(yield* until(response.arrayBuffer()));
  verifyHash(pin.url, bytes, pin.sha256);
  if (bytes.length !== pin.bytes) {
    throw new Error(`${pin.url}: expected ${pin.bytes} bytes, actual ${bytes.length}`);
  }
  return bytes;
}

function writeScratch(path: string, bytes: string | Uint8Array): Operation<void> {
  return scoped(function* () {
    let writing: Promise<void> = Promise.resolve();
    yield* ensure(() =>
      until(
        writing.then(
          () => {},
          () => {},
        ),
      ),
    );
    writing = writeFile(path, bytes);
    yield* until(writing);
  });
}

function* command(cwd: string, executable: string, args: string[]): Operation<void> {
  console.log(`Claude preparation: ${executable} ${args.join(" ")}`);
  yield* scoped(() => exec(executable, { arguments: args, cwd }).expect());
}

function* images(root: string, expected: Record<string, string | null>): Operation<void> {
  for (const [name, hash] of Object.entries(expected)) {
    const path = join(root, name);
    if (hash === null) {
      if (yield* exists(path)) {
        throw new Error(`${name}: expected absent patch preimage`);
      }
    } else {
      verifyHash(name, yield* until(readFile(path)), hash);
    }
  }
}

export function* verifyClaudeRuntime(
  root: string,
  expected: Record<string, string>,
): Operation<void> {
  const files = (yield* until(readdir(join(root, "dist"), { recursive: true })))
    .filter((path) => /\.(?:js|mjs)$/.test(path))
    .map((path) => `dist/${path.replaceAll("\\", "/")}`)
    .sort();
  const names = Object.keys(expected).sort();
  for (const name of new Set([...files, ...names])) {
    const hash = expected[name];
    if (!hash || !files.includes(name)) {
      throw new Error(
        `${name}: expected ${hash ?? "absent"}, actual ${files.includes(name) ? "unexpected executable" : "missing"}`,
      );
    }
    verifyHash(name, yield* until(readFile(join(root, name))), hash);
  }
}

const SourcePackage = z.object({
  name: z.string(),
  version: z.string(),
  description: z.string(),
  main: z.string(),
  bin: z.record(z.string(), z.string()),
  type: z.string(),
  keywords: z.array(z.string()),
  homepage: z.string(),
  bugs: z.object({ url: z.string() }),
  repository: z.object({ type: z.string(), url: z.string() }),
  author: z.string(),
  license: z.string(),
  engines: z.record(z.string(), z.string()),
  dependencies: z.record(z.string(), z.string()),
});

function runtimePackage(source: unknown): string {
  const parsed = SourcePackage.parse(source);
  const {
    name,
    version,
    description,
    main,
    bin,
    type,
    keywords,
    homepage,
    bugs,
    repository,
    author,
    license,
    engines,
    dependencies,
  } = parsed;
  const { ["@anthropic-ai/claude-agent-sdk"]: _sdk, ...remaining } = dependencies;
  return (
    JSON.stringify(
      {
        name,
        version,
        description,
        main,
        bin,
        type,
        exports: { ".": { import: "./dist/lib.js" }, "./*": "./*" },
        keywords,
        homepage,
        bugs,
        repository,
        author,
        license,
        engines,
        dependencies: remaining,
      },
      null,
      2,
    ) + "\n"
  );
}

/** Compile only in invocation-private scratch; callers verify the final container before publication. */
export function* buildClaudePayload(
  repoRoot: URL,
  recipe: ClaudeRecipe,
  inputs?: { source: Uint8Array; sdk: Uint8Array },
): Operation<Uint8Array> {
  if (recipeInputsSha256(recipe) !== recipe.inputsSha256) {
    throw new Error("Claude recipe input hash mismatch");
  }
  const scratch = yield* useTempDirectory("xmd-claude-prepare-");
  const source = join(scratch, "source");
  const sdk = join(scratch, "sdk");
  for (const tool of ["node", "npm", "git"]) {
    yield* command(scratch, tool, ["--version"]);
  }
  const patch = yield* readTextFile(new URL(`${VENDOR}adapter.patch`, repoRoot));
  const transform = yield* readTextFile(new URL(`${VENDOR}sdk-transform.mjs`, repoRoot));
  const notice = yield* readTextFile(new URL(`${VENDOR}SDK-NOTICE.md`, repoRoot));
  verifyHash("adapter.patch", patch, recipe.patchSha256);
  verifyHash("sdk-transform.mjs", transform, recipe.transformSha256);
  verifyHash("SDK-NOTICE.md", notice, recipe.noticeSha256);
  const sourceBytes = inputs?.source ?? (yield* downloadClaudeInput(recipe.source));
  const sdkBytes = inputs?.sdk ?? (yield* downloadClaudeInput(recipe.sdk));
  verifyHash("source archive", sourceBytes, recipe.source.sha256);
  verifyHash("SDK archive", sdkBytes, recipe.sdk.sha256);
  if (`sha512-${createHash("sha512").update(sdkBytes).digest("base64")}` !== recipe.sdk.integrity) {
    throw new Error("SDK archive SHA-512 integrity mismatch");
  }
  yield* ensureDir(source);
  yield* ensureDir(sdk);
  yield* writeScratch(join(scratch, "source.tgz"), sourceBytes);
  yield* writeScratch(join(scratch, "sdk.tgz"), sdkBytes);
  yield* command(scratch, "tar", ["-xzf", "source.tgz", "--strip-components=1", "-C", source]);
  yield* command(scratch, "tar", ["-xzf", "sdk.tgz", "--strip-components=1", "-C", sdk]);
  verifyHash(
    "package-lock.json",
    yield* readTextFile(join(source, "package-lock.json")),
    recipe.sourceLockSha256,
  );
  const lock = z
    .object({ packages: z.record(z.string(), z.unknown()) })
    .parse(JSON.parse(yield* readTextFile(join(source, "package-lock.json"))));
  const compiler = z
    .object({ version: z.string(), resolved: z.string(), integrity: z.string() })
    .parse(lock.packages["node_modules/typescript"]);
  if (
    compiler.version !== recipe.compiler.version ||
    compiler.resolved !== recipe.compiler.resolved ||
    compiler.integrity !== recipe.compiler.integrity
  ) {
    throw new Error("Pinned TypeScript lock input mismatch");
  }
  yield* images(source, recipe.preimages);
  yield* writeScratch(join(scratch, "adapter.patch"), patch);
  yield* command(source, "git", ["apply", "--check", join(scratch, "adapter.patch")]);
  yield* command(source, "git", ["apply", join(scratch, "adapter.patch")]);
  yield* images(source, recipe.postimages);
  verifyHash("SDK module", yield* readTextFile(join(sdk, "sdk.mjs")), recipe.sdkModuleSha256);
  verifyHash(
    "SDK declarations",
    yield* readTextFile(join(sdk, "sdk.d.ts")),
    recipe.sdkDeclarationsSha256,
  );
  const sdkReadme = yield* readTextFile(join(sdk, "README.md"));
  if (!notice.includes(sdkReadme.trim())) {
    throw new Error("SDK-NOTICE.md omits the verified upstream terms");
  }
  yield* command(source, "npm", [
    "ci",
    "--ignore-scripts",
    "--omit=optional",
    "--no-audit",
    "--no-fund",
    "--cache",
    join(scratch, "npm-cache"),
  ]);
  const installedCompiler = z
    .object({ version: z.string() })
    .parse(JSON.parse(yield* readTextFile(join(source, "node_modules/typescript/package.json"))));
  if (installedCompiler.version !== recipe.compiler.version) {
    throw new Error("Installed TypeScript version mismatch");
  }
  yield* ensureDir(join(source, "dist/sdk"));
  yield* writeScratch(join(scratch, "sdk-transform.mjs"), transform);
  const module = yield* until(import(pathToFileURL(join(scratch, "sdk-transform.mjs")).href));
  const transformed = z
    .string()
    .parse(module.transformSdk(yield* readTextFile(join(sdk, "sdk.mjs"))));
  verifyHash("repaired SDK", transformed, recipe.runtime["dist/sdk/sdk.mjs"]!);
  yield* writeScratch(join(source, "dist/sdk/sdk.mjs"), transformed);
  yield* writeScratch(
    join(source, "dist/sdk/sdk.d.mts"),
    'export * from "@anthropic-ai/claude-agent-sdk";\n',
  );
  yield* writeScratch(
    join(source, "tsconfig.runtime.json"),
    JSON.stringify({
      extends: "./tsconfig.json",
      compilerOptions: { newLine: "lf" },
      exclude: ["src/tests", "node_modules", "dist"],
    }),
  );
  yield* command(source, "node", [
    "node_modules/typescript/bin/tsc",
    "--project",
    "tsconfig.runtime.json",
  ]);
  yield* verifyClaudeRuntime(source, recipe.runtime);
  const members: ClaudeMember[] = [];
  for (const path of recipe.files) {
    let text: string;
    if (path === "package.json") {
      text = runtimePackage(JSON.parse(yield* readTextFile(join(source, path))));
      if (text !== JSON.stringify(recipe.metadata, null, 2) + "\n") {
        throw new Error("Claude runtime package metadata mismatch");
      }
    } else if (path === "SDK-NOTICE.md") {
      text = notice;
    } else {
      text = yield* readTextFile(join(source, path));
    }
    members.push({ path, bytes: new TextEncoder().encode(text.replaceAll("\r\n", "\n")) });
  }
  return yield* packClaude(members);
}

export function prepareClaude(
  repoRoot: URL,
  output = new URL(CLAUDE_OUTPUT, repoRoot),
): Operation<void> {
  return scoped(function* () {
    const recipe = ClaudeRecipe.parse(
      JSON.parse(yield* readTextFile(new URL(CLAUDE_RECIPE, repoRoot))),
    );
    const bytes = yield* buildClaudePayload(repoRoot, recipe);
    yield* publishClaude(output, bytes, recipe);
  });
}

export function* publishClaude(
  output: URL,
  bytes: Uint8Array,
  recipe: ClaudeRecipe,
): Operation<void> {
  verifyHash("Claude archive", bytes, recipe.expected.sha256);
  if (bytes.length !== recipe.expected.byteLength) {
    throw new Error(
      `Claude archive: expected length ${recipe.expected.byteLength}, actual ${bytes.length}`,
    );
  }
  const source = claudeSnapshotModule(bytes);
  verifyHash("Claude module", source, recipe.expected.moduleSha256);
  yield* ensureDir(fileURLToPath(new URL(".", output)));
  yield* replaceThroughStaging(output, source);
}
