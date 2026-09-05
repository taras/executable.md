/**
 * Tier SYN — a JSR consumer's named lookup.
 *
 * Two claims, and they are different. That `components.md` appears in
 * `deno publish --dry-run` says the asset is *selected into the payload* — the
 * publish filter keeps it, rather than dropping it as tooling. That a consumer
 * can render it says the asset is *reachable from the published layout*, which
 * is a fact about how the module resolves it and not about the file list.
 *
 * So this proves both, in that order, and stages exactly what publish selected
 * rather than copying a source directory: a recursive copy would pass even if
 * the publish filter excluded every asset. The consumer then writes ordinary
 * XMD and invokes the public `<Syntax names={…}>` surface, because that is the
 * thing an author actually reaches — calling the index directly would skip
 * selection, the renderer, availability and the whole component.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, until } from "effection";
import type { Operation } from "effection";
import { ensureDir, writeTextFile } from "@effectionx/fs";
import { exec } from "@effectionx/process";
import { timebox } from "@effectionx/timebox";
import type { ProcessResult } from "@effectionx/process";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "npm:zod@^4";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const TIMEOUT = 180_000;

/** The workspace members a consumer of core has to resolve. */
const MEMBERS = ["core", "runtime", "durable-streams", "acp"] as const;

/** Every documentation asset the product ships, by package-relative path. */
const ASSETS: Record<string, readonly string[]> = {
  core: ["src/components/components.md", "src/agent/components.md"],
};

/** A package manifest, only as far as this needs it. */
const Manifest = z.object({
  exports: z.union([z.string(), z.record(z.string(), z.string())]),
});

/** The document the consumer runs: the public surface, nothing else. */
const CONSUMER_DOCUMENT = '<Syntax names={["Elicit", "Prompt"]} />\n';

/** Which files `deno publish` would actually send, for one package. */
function* publishedFiles(pkg: string): Operation<string[]> {
  const dry = yield* timebox<ProcessResult>(TIMEOUT, function* () {
    return yield* exec(Deno.execPath(), {
      // Not `--quiet`: the file listing *is* the evidence, and quiet suppresses
      // exactly the lines this reads.
      arguments: ["publish", "--dry-run", "--allow-dirty"],
      cwd: path.join(ROOT, "packages", pkg),
      env: Deno.env.toObject(),
    }).join();
  });
  if (dry.timeout) {
    throw new Error(`deno publish --dry-run timed out for ${pkg}`);
  }
  const listed: string[] = [];
  for (const line of `${dry.value.stdout}\n${dry.value.stderr}`.split("\n")) {
    const trimmed = line.trim();
    const marker = trimmed.indexOf("file:///");
    if (marker === -1) {
      continue;
    }
    const url = trimmed.slice(marker).split(" ")[0] ?? "";
    listed.push(fileURLToPath(url));
  }
  return listed;
}

describe("Tier SYN — a staged JSR consumer", () => {
  it("SYN47: publishes the documentation assets and renders them for a consumer", function* () {
    // 1. The publish filter selects the assets. This is the payload claim, and
    //    it is checked against the real `deno publish` selection rather than
    //    against a directory listing.
    const selected = yield* publishedFiles("core");
    expect(selected.length).toBeGreaterThan(0);
    for (const asset of ASSETS.core ?? []) {
      const expected = path.join(ROOT, "packages/core", asset);
      expect([asset, selected.includes(expected)]).toEqual([asset, true]);
    }

    const staged = yield* until(mkdtemp(path.join(tmpdir(), "xmd-jsr-consumer-")));
    yield* ensure(function* () {
      yield* until(rm(staged, { recursive: true, force: true }));
    });

    // 2. Stage exactly what publish selected, file by file. A recursive copy
    //    would pass even if the filter dropped every asset, which is the thing
    //    this case exists to catch.
    const staging: Record<string, string> = {};
    for (const member of MEMBERS) {
      const from = path.join(ROOT, "packages", member);
      const to = path.join(staged, member);
      const files = member === "core" ? selected : yield* publishedFiles(member);
      for (const file of files) {
        const relative = path.relative(from, file);
        if (relative.startsWith("..")) {
          continue;
        }
        const target = path.join(to, relative);
        yield* until(mkdir(path.dirname(target), { recursive: true }));
        yield* until(cp(file, target));
      }
      staging[member] = to;
    }

    // Every asset is in the staged tree because publish selected it, not
    // because a copy swept the directory.
    for (const asset of ASSETS.core ?? []) {
      const stagedAsset = path.join(staging.core ?? "", asset);
      expect([asset, yield* exists(stagedAsset)]).toEqual([asset, true]);
    }

    // 3. A consumer outside the repository, resolving the staged packages
    //    through an import map of its own that names no path in this checkout.
    const consumer = path.join(staged, "consumer");
    yield* ensureDir(consumer);
    yield* writeTextFile(path.join(consumer, "document.md"), CONSUMER_DOCUMENT);
    const imports = yield* consumerImports(staging);
    yield* writeTextFile(path.join(consumer, "deno.json"), JSON.stringify({ imports }, null, 2));
    yield* writeTextFile(
      path.join(consumer, "main.ts"),
      [
        "// The public surface, assembled the way a consumer would: core's own",
        "// registrations plus its Agent boundary, so the document can name a",
        "// component from each of the two documentation assets.",
        "import {",
        "  AGENT_REGISTRATIONS,",
        "  agentDocumentation,",
        "  collect,",
        "  registerComponents,",
        '} from "@executablemd/core";',
        "// The host boundary is its own entrypoint, and a consumer reaches it",
        "// the same way: `@executablemd/core/host`.",
        'import { executeInstalled } from "@executablemd/core/host";',
        'import { InMemoryStream } from "@executablemd/durable-streams";',
        'import { main, scoped, until } from "effection";',
        'import { readFile } from "node:fs/promises";',
        "",
        "await main(function* () {",
        '  const content = yield* until(readFile("document.md", "utf8"));',
        "  const rendered = yield* scoped(function* () {",
        "    yield* registerComponents(AGENT_REGISTRATIONS);",
        "    return yield* collect(",
        "      yield* executeInstalled(",
        "        {",
        '          path: "document.md",',
        "          content,",
        "          stream: new InMemoryStream(),",
        "          includes: [],",
        "        },",
        "        [{ documentation: [yield* agentDocumentation()] }],",
        "      ),",
        "    );",
        "  });",
        "  console.log(String(rendered));",
        "});",
      ].join("\n"),
    );

    const run = yield* timebox<ProcessResult>(TIMEOUT, function* () {
      return yield* exec(Deno.execPath(), {
        arguments: ["run", "--allow-all", "main.ts"],
        cwd: consumer,
        env: Deno.env.toObject(),
      }).join();
    });
    if (run.timeout) {
      throw new Error("the staged JSR consumer timed out");
    }
    if (run.value.code !== 0) {
      throw new Error(`the staged JSR consumer exited ${run.value.code}\n${run.value.stderr}`);
    }

    // 4. The same program, resolved against the workspace source instead of the
    //    staged packages. One document, one profile, two resolutions — so the
    //    only thing the comparison can differ on is the distribution, which is
    //    exactly what is under test. Comparing against a different profile
    //    would compare two catalogs and prove nothing about packaging.
    const fromSource = yield* timebox<ProcessResult>(TIMEOUT, function* () {
      return yield* exec(Deno.execPath(), {
        arguments: ["run", "--allow-all", "--config", path.join(ROOT, "deno.json"), "main.ts"],
        cwd: consumer,
        env: Deno.env.toObject(),
      }).join();
    });
    if (fromSource.timeout) {
      throw new Error("the source surface timed out");
    }

    expect(run.value.stdout.trimEnd()).toBe(fromSource.value.stdout.trimEnd());
    // And it is a real answer: both components, from two different asset
    // files, with their metadata and availability.
    expect(run.value.stdout).toContain("### `<Elicit>`");
    expect(run.value.stdout).toContain("### `<Prompt>`");
    expect(run.value.stdout).toContain("Asks a person a structured question");
    expect(run.value.stdout).toContain("Sends a prompt and renders the reply");
    expect(run.value.stdout).toContain("`@executablemd/core` (registered default)");
    expect(run.value.stdout).toContain("**Available in this evaluation:** yes");
  });
});

/** The import map a consumer of the staged packages writes. */
function* consumerImports(staging: Record<string, string>): Operation<Record<string, string>> {
  const rootManifest = z
    .object({ imports: z.record(z.string(), z.string()) })
    .parse(JSON.parse(yield* until(Deno.readTextFile(path.join(ROOT, "deno.json")))));

  const imports: Record<string, string> = {};
  // External dependencies resolve as they would for any consumer; workspace
  // paths do not travel, which is the point of staging.
  for (const [name, target] of Object.entries(rootManifest.imports)) {
    if (target.startsWith("npm:") || target.startsWith("jsr:") || target.startsWith("http")) {
      imports[name] = target;
    }
  }
  for (const [name, dir] of Object.entries(staging)) {
    const manifest = Manifest.parse(
      JSON.parse(yield* until(Deno.readTextFile(path.join(dir, "deno.json")))),
    );
    const exported =
      typeof manifest.exports === "string" ? { ".": manifest.exports } : manifest.exports;
    for (const [subpath, target] of Object.entries(exported)) {
      const specifier =
        subpath === "."
          ? `@executablemd/${name}`
          : `@executablemd/${name}/${subpath.replace(/^\.\//, "")}`;
      imports[specifier] = path.join(dir, target);
    }
  }
  return imports;
}

/** Whether a staged path is present. */
function* exists(target: string): Operation<boolean> {
  try {
    yield* until(Deno.stat(target));
    return true;
  } catch {
    return false;
  }
}
