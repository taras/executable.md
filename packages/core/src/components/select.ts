/**
 * Deciding what a component name means (spec §5.3).
 *
 * One resolver answers for both execution and inspection, so they cannot
 * disagree about which tier won:
 *
 * 1. structural syntax the engine owns;
 * 2. a host claiming the name — a reserved registration, or exact Markdown this
 *    environment declares. Two claims on one name are refused where they are
 *    installed, so this tier never has to choose between them;
 * 3. the workflow component bundle this execution is closed over;
 * 4. a repository-local file;
 * 5. a registered default, including core's own components;
 * 6. nothing, which is the unresolved printed error.
 *
 * The bundle tier exists only while a trusted host installed one, and a
 * workflow execution searches no repository directories at all — so what a
 * bundled name resolves to is the pinned source and never a file beside it.
 *
 * A repository file therefore overrides any ordinary package default, core's
 * included, while a reserved registration overrides the repository. Only
 * genuine absence falls through: a candidate that exists but cannot be read,
 * imported, parsed, or compiled fails where it is loaded, after selection, so a
 * broken local component is never silently replaced by a default.
 */

import { stat } from "@executablemd/runtime";
import type { Operation } from "effection";
import type { WorkflowImportAuthority } from "./bundle.ts";
import type { DeclaredMarkdownCatalog } from "./declared-markdown.ts";
import { mergeRegistry } from "./registration.ts";
import { CORE_REGISTRY } from "./registry.ts";
import { RESERVED_STRUCTURAL } from "../structural.ts";
import type { ComponentOrigin, ComponentRegistry, ComponentSelection } from "../types.ts";

/** Where components are looked for when nothing else is configured. */
export const DEFAULT_INCLUDES: readonly string[] = ["components", "."];

export interface SelectOptions {
  includes?: readonly string[];
  /** What a host or package registered; core's defaults are added beneath it. */
  registry?: ComponentRegistry;
  /**
   * The component bundle this execution is closed over, when a trusted host
   * installed one.
   *
   * Execution-owned: ordinary `execute()`, `xmd run`, and every inspection
   * resolve without it, so nothing outside a workflow run learns that a bundle
   * exists or can ask to resolve through one.
   */
  workflow?: WorkflowImportAuthority;
  /**
   * The exact Markdown this environment declares, when a trusted host declared
   * any.
   *
   * Host-owned: it crosses on an installation by value, so nothing a document,
   * a component or middleware can reach decides that a name is declared or what
   * it is declared as. Inspection and validation read the same catalog, which is
   * what stops them describing an environment execution would not have.
   */
  declared?: DeclaredMarkdownCatalog;
}

/** Strip leading ./ from paths for workspace-relative normalization. */
function normalizePath(path: string): string {
  return path.replace(/^\.\//, "");
}

function candidates(baseName: string, dir: string): string[] {
  const prefix = dir === "." ? "" : `${dir}/`;
  return [
    `${prefix}${baseName}.md`,
    `${prefix}${baseName}.ts`,
    `${prefix}${baseName}/index.md`,
    `${prefix}${baseName}/index.ts`,
  ].map(normalizePath);
}

/**
 * The first repository candidate that exists, or undefined.
 *
 * Selection reads nothing: it asks only whether a file is there. A directory
 * that cannot be examined at all propagates rather than counting as absence, so
 * an unreadable tree is not mistaken for a missing component.
 */
export function* probeComponentPath(
  name: string,
  includes: readonly string[],
): Operation<string | undefined> {
  const baseName = name.replace(/\./g, "/");
  for (const dir of includes) {
    for (const candidate of candidates(baseName, dir)) {
      const found = yield* stat(candidate);
      if (found.exists && found.isFile) {
        return candidate;
      }
    }
  }
  return undefined;
}

function registeredOrigins(entry: { reserved?: { origin: string }; default?: { origin: string } }) {
  const origins: ComponentOrigin[] = [];
  if (entry.reserved) {
    origins.push({ kind: "registered", origin: entry.reserved.origin, reserved: true });
  }
  if (entry.default) {
    origins.push({ kind: "registered", origin: entry.default.origin, reserved: false });
  }
  return origins;
}

/**
 * What a scope's registrations resolve against: core's defaults with whatever a
 * host or package registered layered over them.
 */
export function effectiveRegistry(registry?: ComponentRegistry): ComponentRegistry {
  return mergeRegistry(CORE_REGISTRY, registry ?? new Map());
}

export function* selectComponent(
  name: string,
  options: SelectOptions = {},
): Operation<ComponentSelection> {
  const includes = options.includes ?? DEFAULT_INCLUDES;
  const entry = effectiveRegistry(options.registry).get(name);

  if (RESERVED_STRUCTURAL.has(name)) {
    return { kind: "structural", construct: name };
  }

  if (entry?.reserved) {
    return {
      kind: "registered",
      definition: entry.reserved.definition,
      origin: { kind: "registered", origin: entry.reserved.origin, reserved: true },
    };
  }

  const declared = options.declared?.component(name);
  if (declared !== undefined) {
    return {
      kind: "declared-markdown",
      origin: declared.origin,
      digest: declared.digest,
      source: declared.source,
      forms: declared.forms,
      definition: declared.definition,
      ...(declared.returnDisposition === undefined
        ? {}
        : { returnDisposition: declared.returnDisposition }),
    };
  }

  // A name some declaration keeps to itself resolves to nothing here. Selection
  // is the wrong place to decide *whether* an element may write one — that is
  // lexical, and canonical core answers it where the element is expanded — but
  // it is the right place to stop every other tier answering for it. Without
  // this a repository file, a bundle member or a registration under a private
  // name would run wherever the closure did not apply.
  if (options.declared?.isPrivate(name) === true) {
    return { kind: "unresolved", searched: [...includes], registered: [] };
  }

  const bundled = options.workflow?.component(name);
  if (bundled !== undefined) {
    return {
      kind: "workflow",
      path: bundled.path,
      sourceHash: bundled.sourceHash,
      content: bundled.content,
    };
  }

  const path = yield* probeComponentPath(name, includes);
  if (path !== undefined) {
    return { kind: "repository", path };
  }

  if (entry?.default) {
    return {
      kind: "registered",
      definition: entry.default.definition,
      origin: { kind: "registered", origin: entry.default.origin, reserved: false },
    };
  }

  return {
    kind: "unresolved",
    searched: [...includes],
    registered: entry ? registeredOrigins(entry) : [],
  };
}

/** The printed error a name that resolves to nothing produces. */
export function unresolvedMessage(name: string, searched: readonly string[]): string {
  return `Cannot resolve component: ${name} (searched: ${searched.join(", ")})`;
}
