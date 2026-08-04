/**
 * Deciding what a component name means (spec §5.3).
 *
 * One resolver answers for both execution and inspection, so they cannot
 * disagree about which tier won:
 *
 * 1. structural syntax the engine owns;
 * 2. a reserved registration — a host protecting an invariant;
 * 3. a repository-local file;
 * 4. a registered default, including core's own components;
 * 5. nothing, which is the unresolved printed error.
 *
 * A repository file therefore overrides any ordinary package default, core's
 * included, while a reserved registration overrides the repository. Only
 * genuine absence falls through: a candidate that exists but cannot be read,
 * imported, parsed, or compiled fails where it is loaded, after selection, so a
 * broken local component is never silently replaced by a default.
 */

import { stat } from "@executablemd/runtime";
import type { Operation } from "effection";
import { mergeRegistry } from "./registration.ts";
import { CORE_REGISTRY } from "./registry.ts";
import { RESERVED_STRUCTURAL } from "../structural.ts";
import type { ComponentOrigin, ComponentRegistry, ComponentSelection } from "../types.ts";

/** Where components are looked for when nothing else is configured. */
export const DEFAULT_COMPONENT_DIRS: readonly string[] = ["components", "."];

export interface SelectOptions {
  componentDirs?: readonly string[];
  /** What a host or package registered; core's defaults are added beneath it. */
  registry?: ComponentRegistry;
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
  componentDirs: readonly string[],
): Operation<string | undefined> {
  const baseName = name.replace(/\./g, "/");
  for (const dir of componentDirs) {
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
  const componentDirs = options.componentDirs ?? DEFAULT_COMPONENT_DIRS;
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

  const path = yield* probeComponentPath(name, componentDirs);
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
    searched: [...componentDirs],
    registered: entry ? registeredOrigins(entry) : [],
  };
}

/** The printed error a name that resolves to nothing produces. */
export function unresolvedMessage(name: string, searched: readonly string[]): string {
  return `Cannot resolve component: ${name} (searched: ${searched.join(", ")})`;
}
