/**
 * Tier WFD — the component bundle a workflow root declares.
 *
 * A root closes itself over a fixed set of authored components by writing them
 * in its own frontmatter:
 *
 * ```yaml
 * workflow:
 *   components:
 *     Discovery: ./Discovery.md
 * ```
 *
 * Reading that declaration is a decision about identity, so it is deliberately
 * narrow: one member, a non-empty mapping, component names the engine does not
 * already own, and relative POSIX Markdown paths that stay inside the tree. A
 * value that is nearly one of those is refused rather than repaired, because a
 * repaired declaration runs a file the author did not write down.
 *
 * Nothing here reads a repository. The declaration is normalized against the
 * root's own path in the pinned tree, and what comes back is what Git is then
 * asked for.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { declaredBundle } from "../src/workflow-bundle.ts";
import type { DeclaredComponent } from "../src/workflow-bundle.ts";
import { ensure, scoped, until } from "effection";
import type { Operation } from "effection";
import { ensureDir, rm, writeTextFile } from "@effectionx/fs";
import { writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sourceContentHash } from "@executablemd/workflow";
import { establishDefinition } from "../src/workflow-definition.ts";

const ROOT = "workflows/loop.md";

/** The five names the representative authored workflow declares. */
const FIVE = {
  InstructionFiles: "./InstructionFiles.md",
  Discovery: "./Discovery.md",
  UserCheckpoint: "./UserCheckpoint.md",
  Planning: "./Planning.md",
  Implementation: "./Implementation.md",
};

function declare(components: unknown, root = ROOT) {
  return declaredBundle({ workflow: { components } }, root);
}

function accepted(components: unknown, root = ROOT): readonly DeclaredComponent[] {
  const result = declare(components, root);
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

function refused(components: unknown, root = ROOT): string {
  const result = declare(components, root);
  if (result.ok) {
    throw new Error("expected the declaration to be refused");
  }
  return result.error.message;
}

describe("Tier WFD — reading a workflow's component declaration", () => {
  it("WFD1: the five-name map normalizes against a nested root", function* () {
    expect(accepted(FIVE)).toEqual([
      { name: "Discovery", path: "workflows/Discovery.md" },
      { name: "Implementation", path: "workflows/Implementation.md" },
      { name: "InstructionFiles", path: "workflows/InstructionFiles.md" },
      { name: "Planning", path: "workflows/Planning.md" },
      { name: "UserCheckpoint", path: "workflows/UserCheckpoint.md" },
    ]);
  });

  it("WFD2: the order the author wrote is not the order identity keeps", function* () {
    const reversed = Object.fromEntries(Object.entries(FIVE).reverse());

    expect(accepted(reversed)).toEqual(accepted(FIVE));
  });

  it("WFD3: a root at the repository root normalizes without a directory", function* () {
    expect(accepted({ Discovery: "./stages/Discovery.md" }, "loop.md")).toEqual([
      { name: "Discovery", path: "stages/Discovery.md" },
    ]);
    expect(accepted({ Discovery: "stages/Discovery.md" }, "loop.md")).toEqual([
      { name: "Discovery", path: "stages/Discovery.md" },
    ]);
  });

  it("WFD4: two names may point at one blob on purpose", function* () {
    expect(accepted({ Discovery: "./Stage.md", Planning: "./Stage.md" })).toEqual([
      { name: "Discovery", path: "workflows/Stage.md" },
      { name: "Planning", path: "workflows/Stage.md" },
    ]);
  });

  it("WFD5: a root that declares nothing declares no bundle", function* () {
    const absent = declaredBundle({}, ROOT);
    expect(absent.ok && absent.value).toEqual([]);

    const other = declaredBundle({ title: "Loop" }, ROOT);
    expect(other.ok && other.value).toEqual([]);
  });

  it("WFD6: an empty map is not a second spelling of no bundle", function* () {
    expect(refused({})).toContain("declares no component");
  });

  it("WFD7: the declaration is one closed member", function* () {
    for (const declaration of [null, "components", ["Discovery"], 7]) {
      const result = declaredBundle({ workflow: declaration }, ROOT);
      expect(result.ok).toBe(false);
    }

    const extra = declaredBundle(
      { workflow: { components: { Discovery: "./Discovery.md" }, version: 1 } },
      ROOT,
    );
    expect(extra.ok).toBe(false);
    expect(!extra.ok && extra.error.message).toContain('exactly one member, "components"');

    const missing = declaredBundle({ workflow: {} }, ROOT);
    expect(missing.ok).toBe(false);

    for (const components of [null, "Discovery.md", ["Discovery.md"], 7]) {
      expect(refused(components)).toContain("mapping of name to path");
    }
  });

  it("WFD8: a value that is not a path is not a declaration", function* () {
    for (const value of [null, 7, true, ["./Discovery.md"], { path: "./Discovery.md" }]) {
      expect(refused({ Discovery: value })).toContain("without a path");
    }
  });

  it("WFD9: every path form a declaration may not take", function* () {
    const refusals: Array<[string, string]> = [
      ["", "is empty"],
      ["/etc/passwd", "is absolute"],
      ["workflows\\Discovery.md", "backslash"],
      ["Discovery\u0000.md", "NUL"],
      ["../Discovery.md", "walks the tree"],
      ["./../Discovery.md", "walks the tree"],
      // Inside the repository after normalization, and still refused: a
      // declaration names a file beside the document, not a route to one.
      ["../workflows/Discovery.md", "walks the tree"],
      ["./stages/./Discovery.md", "walks the tree"],
      ["stages//Discovery.md", "empty segment"],
      ["https://example.invalid/Discovery.md", "is a URL"],
      ["file:///Discovery.md", "is a URL"],
      ["@scope/package/Discovery.md", "is a package specifier"],
      ["./stages/*.md", "glob syntax"],
      ["./stages/{a,b}.md", "glob syntax"],
      ["./stages/", "names a directory"],
      ["./Discovery.ts", "is not a Markdown file"],
      ["./Discovery.MD", "is not a Markdown file"],
      ["./Discovery", "is not a Markdown file"],
    ];

    for (const [path, says] of refusals) {
      const message = refused({ Discovery: path });
      expect({ path, says: message.includes(says) }).toEqual({ path, says: true });
      // The path a run would have opened is named, because it is what the
      // author must change. Nothing else about the document is.
      expect(message).toContain('"Discovery"');
    }
  });

  it("WFD10: a declaration may not claim structural syntax or a core component", function* () {
    for (const name of ["If", "Each", "Output", "PrintErrors"]) {
      expect(refused({ [name]: "./Stage.md" })).toContain("structural syntax");
    }
    for (const name of ["File", "Parse", "Test", "Fetch", "Glob", "TempDir", "Elicit"]) {
      expect(refused({ [name]: "./Stage.md" })).toContain("the engine supplies");
    }
  });

  it("WFD11: a key that is not a component name is never printed back", function* () {
    // A distinctive string rather than a credential-shaped one. What this proves
    // is that a refused key is not echoed, and a value shaped like a token would
    // put one into the diff of every review of this file.
    const canary = "never-printed-canary-b7a1e9";

    for (const name of [
      "discovery",
      "1Discovery",
      "Discovery-Stage",
      "",
      "Discovery.stage",
      canary,
    ]) {
      const message = refused({ [name]: "./Stage.md" });
      expect({ name, names: message.includes("not a component name") }).toEqual({
        name,
        names: true,
      });
      // Every string contains the empty one, so there is nothing to check for it.
      if (name !== "") {
        expect(message).not.toContain(name);
      }
    }
  });

  it("WFD12: a nested name is a name, and normalizes like one", function* () {
    expect(accepted({ "Stage.Discovery": "./stages/Discovery.md" })).toEqual([
      { name: "Stage.Discovery", path: "workflows/stages/Discovery.md" },
    ]);
  });
});

/**
 * Tier WFD — what a declaration becomes once it is read from disk.
 *
 * The declaration is normalization; this is establishment. A root's own name is
 * the bundle's entrypoint, each declared path is a logical path beside it, and
 * every source's identity is the hash of the bytes that were actually read —
 * so what the descriptor names and what executes come from one read of one
 * file. A component that is not there refuses the start, before any storage
 * exists to refuse it later.
 */
describe("Tier WFD — establishing a declared bundle", () => {
  const PLAIN = "# Plain\n\nno components at all\n";

  function useDirectory<T>(
    files: Record<string, string>,
    body: (directory: string) => Operation<T>,
  ): Operation<T> {
    return scoped(function* () {
      const directory = join(tmpdir(), `xmd-wfd-${randomUUID()}`);
      yield* ensure(() => rm(directory, { recursive: true, force: true }));
      for (const [name, content] of Object.entries(files)) {
        const at = join(directory, name);
        yield* ensureDir(join(at, ".."));
        yield* writeTextFile(at, content);
      }
      return yield* body(directory);
    });
  }

  function* established(directory: string, name: string) {
    return yield* establishDefinition(join(directory, name));
  }

  it("WFD40: a root with no declaration retains exactly one source", function* () {
    yield* useDirectory({ "plain.md": PLAIN }, function* (directory) {
      const result = yield* established(directory, "plain.md");
      if (!result.ok) {
        throw result.error;
      }
      const { definition, sourceSnapshot } = result.value;

      expect(definition.entrypoint).toBe("plain.md");
      expect(definition.sources.map((source) => source.path)).toEqual(["plain.md"]);
      expect("components" in definition).toBe(false);
      // The identity is the bytes that were read, and the snapshot is those
      // bytes: one read, two views of it.
      expect(definition.sources[0]?.byteLength).toBe(new TextEncoder().encode(PLAIN).byteLength);
      expect(new TextDecoder().decode(sourceSnapshot[0]?.bytes)).toBe(PLAIN);
      expect(definition.sources[0]?.sourceHash).toBe(
        yield* sourceContentHash(new TextEncoder().encode(PLAIN)),
      );
    });
  });

  it("WFD41: a declared component becomes a logical path beside the root", function* () {
    const root = [
      "---",
      "workflow:",
      "  components:",
      "    Stage: ./stages/Stage.md",
      "---",
      "",
      "# Root",
      "",
    ].join("\n");
    const stage = "# Stage\n\nthe stage says this\n";

    yield* useDirectory({ "root.md": root, "stages/Stage.md": stage }, function* (directory) {
      const result = yield* established(directory, "root.md");
      if (!result.ok) {
        throw result.error;
      }
      const { definition, sourceSnapshot, components } = result.value;

      // Bundle-relative, not the absolute path this machine found it at, and
      // in the canonical UTF-8 order the manifest is required to be in.
      expect(definition.sources.map((source) => source.path)).toEqual([
        "root.md",
        "stages/Stage.md",
      ]);
      expect(definition.components).toEqual([{ name: "Stage", path: "stages/Stage.md" }]);
      expect(sourceSnapshot.map((entry) => entry.path)).toEqual(["root.md", "stages/Stage.md"]);

      // The bytes retained for the component are the component's, and the
      // execution view carries the same identity the descriptor does.
      const retained = sourceSnapshot.find((entry) => entry.path === "stages/Stage.md");
      expect(new TextDecoder().decode(retained?.bytes)).toBe(stage);
      expect(components.map((component) => component.name)).toEqual(["Stage"]);
      expect(components[0]?.content).toBe(stage);
      expect(components[0]?.sourceHash).toBe(
        definition.sources.find((source) => source.path === "stages/Stage.md")?.sourceHash,
      );
    });
  });

  it("WFD42: a declared component that is not beside the root refuses the start", function* () {
    const root = [
      "---",
      "workflow:",
      "  components:",
      "    Absent: ./Absent.md",
      "---",
      "",
      "# Root",
      "",
    ].join("\n");

    yield* useDirectory({ "root.md": root }, function* (directory) {
      const result = yield* established(directory, "root.md");
      expect(result.ok).toBe(false);
      expect(result.ok ? "" : result.error.message).toContain("Absent");
    });
  });

  it("WFD43: a root that is not well-formed UTF-8 refuses before anything is read", function* () {
    const directory = join(tmpdir(), `xmd-wfd-${randomUUID()}`);
    yield* ensure(() => rm(directory, { recursive: true, force: true }));
    yield* ensureDir(directory);
    // A lone continuation byte: no decoder produces text from it, and
    // producing replacement characters would parse a document nobody wrote.
    yield* until(writeFile(join(directory, "broken.md"), new Uint8Array([0x23, 0x20, 0x80])));

    const result = yield* establishDefinition(join(directory, "broken.md"));
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.error.message).toContain("UTF-8");
  });
});

/**
 * Tier WFD — the one exact target a reference selects.
 *
 * The argument is a document reference, so `notes.md#Release/Publish` names a
 * section rather than a file whose name ends in `#Release/Publish`. What the
 * descriptor keeps is the canonical target core resolved against the bytes that
 * are about to be retained — never the selector the caller wrote, because two
 * spellings of one request are one run and a glob re-resolved against different
 * bytes would name a different section.
 */
describe("Tier WFD — the target a reference resolves", () => {
  const SECTIONS = [
    "# Release",
    "",
    "## Publish",
    "",
    "publishing.",
    "",
    "## Announce",
    "",
    "announcing.",
    "",
  ].join("\n");

  function useDocument<T>(
    files: Record<string, string>,
    body: (directory: string) => Operation<T>,
  ): Operation<T> {
    return scoped(function* () {
      const directory = join(tmpdir(), `xmd-wfdt-${randomUUID()}`);
      yield* ensure(() => rm(directory, { recursive: true, force: true }));
      for (const [name, content] of Object.entries(files)) {
        const at = join(directory, name);
        yield* ensureDir(join(at, ".."));
        yield* writeTextFile(at, content);
      }
      return yield* body(directory);
    });
  }

  it("WFD44: a selector resolves to one exact target before storage exists", function* () {
    yield* useDocument({ "sections.md": SECTIONS }, function* (directory) {
      const result = yield* establishDefinition(`${join(directory, "sections.md")}#Publish`);
      if (!result.ok) {
        throw result.error;
      }
      const { definition } = result.value;

      // The path is the file, and the fragment never reached it.
      expect(definition.entrypoint).toBe("sections.md");
      expect(definition.sources.map((source) => source.path)).toEqual(["sections.md"]);
      expect(definition.targetPath).toBe("Publish");

      // And the target is outside the bundle hash: the same document without a
      // selector retains the same bytes under the same hash.
      const whole = yield* establishDefinition(join(directory, "sections.md"));
      if (!whole.ok) {
        throw whole.error;
      }
      expect("targetPath" in whole.value.definition).toBe(false);
      expect(whole.value.definition.bundleHash).toBe(definition.bundleHash);
    });
  });

  it("WFD45: a glob resolves to the canonical target, not to itself", function* () {
    yield* useDocument({ "sections.md": SECTIONS }, function* (directory) {
      const result = yield* establishDefinition(`${join(directory, "sections.md")}#Pub*`);
      if (!result.ok) {
        throw result.error;
      }
      // What is retained is what core resolved, so a resume continues the
      // section this start selected rather than re-answering the pattern.
      expect(result.value.definition.targetPath).toBe("Publish");
    });
  });

  it("WFD46: a selector naming no section refuses, before anything is retained", function* () {
    yield* useDocument({ "sections.md": SECTIONS }, function* (directory) {
      const absent = yield* establishDefinition(`${join(directory, "sections.md")}#Nowhere`);
      expect(absent.ok).toBe(false);
      expect(absent.ok ? "" : absent.error.message).toContain("Nowhere");
    });
  });

  it("WFD47: a filename holding a # is addressable, and is not a logical path", function* () {
    yield* useDocument(
      { "od#d.md": "# Odd\n\nthis file really has a hash\n" },
      function* (directory) {
        // `%23` is the one way a reference names it, and it is read as the path
        // rather than split into a selector — which is the whole reason the
        // argument is parsed as a reference before it is resolved as a path.
        const escaped = yield* establishDefinition(`${join(directory, "od%23d.md")}`);
        expect(escaped.ok).toBe(false);
        // Refused for what it is: a logical path inside a bundle admits no `#`,
        // because a retained path holding one could not be told from a path and
        // a target. The refusal names the grammar, not the selector parser.
        expect(escaped.ok ? "" : escaped.error.message).toContain('without a "#"');

        // Read as a plain path, the same argument names nothing at all: the
        // text after the `#` was never part of the filename.
        const unescaped = yield* establishDefinition(`${join(directory, "od#d.md")}`);
        expect(unescaped.ok).toBe(false);
      },
    );
  });
});
