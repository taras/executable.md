/**
 * Tier PB — the package boundary between a grid and the engine.
 *
 * The neutral root is the arrangement and nothing else: a host that wants to
 * place panes as data loads no executable-Markdown integration and no engine.
 * The `/xmd` subpath is the integration, and it is the only side of the package
 * that depends on core. Core depends on neither.
 *
 * Two claims, two kinds of evidence. The static module graph says which modules
 * a specifier pulls in; a load sentinel says whether importing one *ran* the
 * other, which a graph walk cannot answer for a side effect. A row that only
 * walked the graph would pass for a package whose root imported `/xmd` for its
 * side effects alone.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { until } from "effection";
import type { Operation } from "effection";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { terminalGridInstallation, TERMINAL_XMD_ORIGIN } from "../xmd.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE = resolve(HERE, "..");
const CORE = resolve(PACKAGE, "..", "core");

/**
 * Every specifier one module names, in either form.
 *
 * `import "./x.ts"` has no `from`, and it is exactly the form a hidden
 * side-effect edge would take — so a scan that only read `from "…"` would miss
 * the edge this tier exists to rule out.
 */
const SPECIFIER = /(?:from|import)\s+"([^"]+)"/g;

/** Every module one entrypoint's static graph reaches, as absolute paths. */
function* graphOf(entry: string): Operation<string[]> {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined || seen.has(current)) {
      continue;
    }
    seen.add(current);
    const source = yield* until(readFile(current, "utf8"));
    for (const match of source.matchAll(SPECIFIER)) {
      const specifier = match[1];
      if (specifier === undefined || !specifier.startsWith(".")) {
        continue;
      }
      queue.push(resolve(dirname(current), specifier));
    }
  }
  return [...seen];
}

/** Every bare specifier one entrypoint's graph imports. */
function* packagesOf(entry: string): Operation<string[]> {
  const bare = new Set<string>();
  for (const module of yield* graphOf(entry)) {
    const source = yield* until(readFile(module, "utf8"));
    for (const match of source.matchAll(SPECIFIER)) {
      const specifier = match[1];
      if (specifier === undefined || specifier.startsWith(".")) {
        continue;
      }
      bare.add(specifier);
    }
  }
  return [...bare];
}

describe("Tier PB — the neutral root loads no engine", () => {
  it("PB1: the root's static graph reaches neither core nor the /xmd module", function* () {
    const modules = yield* graphOf(join(PACKAGE, "mod.ts"));
    const imported = yield* packagesOf(join(PACKAGE, "mod.ts"));

    expect(modules.some((module) => module.includes("/src/xmd.ts"))).toBe(false);
    expect(imported.some((specifier) => specifier.startsWith("@executablemd/core"))).toBe(false);
  });

  it("PB1: the walk would see a side-effect edge, so the absence above is evidence", function* () {
    // The control. A package root can pull its integration in for its side
    // effects alone, with no binding and no `from`, and a scan blind to that
    // form would report the boundary intact for a package that had none.
    const directory = yield* until(mkdtemp(join(tmpdir(), "xmd-boundary-")));
    try {
      const root = join(directory, "root.ts");
      const hidden = join(directory, "hidden.ts");
      yield* until(writeFile(root, 'import "./hidden.ts";\nexport const value = 1;\n'));
      yield* until(writeFile(hidden, 'import "@executablemd/core";\n'));

      const modules = yield* graphOf(root);
      const imported = yield* packagesOf(root);

      expect(modules.some((module) => module.endsWith("hidden.ts"))).toBe(true);
      expect(imported).toContain("@executablemd/core");
    } finally {
      yield* until(rm(directory, { recursive: true, force: true }));
    }
  });

  it("PB1: the /xmd subpath depends on core, and returns the installation", function* () {
    const imported = yield* packagesOf(join(PACKAGE, "xmd.ts"));

    // The positive edge. Asserting only the absences above would pass for a
    // package whose integration had no dependency at all.
    expect(imported.some((specifier) => specifier.startsWith("@executablemd/core"))).toBe(true);

    const installation = terminalGridInstallation();
    expect(installation.declarations?.map((declaration) => declaration.name)).toEqual([
      "Terminal.Grid",
      "Terminal",
    ]);
    expect(installation.expand).toBeDefined();
    expect(installation.declarations?.[0]?.origin).toBe(TERMINAL_XMD_ORIGIN);
  });

  it("PB1: each call returns a fresh installation record", function* () {
    const first = terminalGridInstallation();
    const second = terminalGridInstallation();

    expect(first).not.toBe(second);
    expect(first.declarations).not.toBe(second.declarations);
  });
});

describe("Tier RN — generic core carries no grid", () => {
  it("RN1: no core production module imports the terminal package or names its syntax", function* () {
    const offenders: string[] = [];
    for (const entry of ["mod.ts", "host.ts"]) {
      for (const module of yield* graphOf(join(CORE, entry))) {
        const source = yield* until(readFile(module, "utf8"));
        if (/@executablemd\/(terminal|grid)/.test(source)) {
          offenders.push(`${module}: imports the package`);
        }
        if (/"Terminal\.Grid"|"Terminal"|"Grid"|"Pane"/.test(source)) {
          offenders.push(`${module}: names the syntax`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
