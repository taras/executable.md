/**
 * The components core supplies (spec §5.3).
 *
 * They resolve no source file: each is already in the module graph, so it ships
 * in the compiled binary and every published package without a search path or a
 * bundling step.
 *
 * They are ordinary **defaults**, not reserved names. A repository component
 * with one of these names is chosen ahead of the default, exactly as it would
 * be ahead of any other package's registration. Nothing here claims a name a
 * document cannot take back.
 *
 * This is the terminal of `selectComponent()` rather than an installation, so
 * execution and inspection resolve against the same defaults without either one
 * having to install them.
 */

import type { ComponentRegistry, RegistryEntry } from "../types.ts";
import Elicit, { props as elicitProps, returns as elicitReturns } from "./Elicit.ts";
import TempDir, { props as tempDirProps } from "./TempDir.ts";
import Fetch, { props as fetchProps } from "./Fetch.ts";
import { form as fileForm, props as fileProps } from "./File.ts";
import { form as fileDeleteForm, props as fileDeleteProps } from "./FileDelete.ts";
import Glob, { props as globProps, returns as globReturns } from "./Glob.ts";
import Json, { props as jsonProps } from "./Json.ts";
import Parse, { props as parseProps, returns as parseReturns } from "./Parse.ts";
import SafeParse, { props as safeParseProps, returns as safeParseReturns } from "./SafeParse.ts";
import Test, { props as testProps } from "./Test.ts";
import { parseJsonObject } from "../json.ts";
import { formDispatcher } from "../invocation-identity.ts";
import type { FormDeclaration, FunctionComponent, PropsSchema, ReturnsSchema } from "../types.ts";

/** The origin every core component reports to inspection. */
export const CORE_ORIGIN = "@executablemd/core";

/**
 * What a core default declares beyond its name, function and props schema.
 *
 * Both members are what a `registerComponents()` registration may declare and a
 * props schema cannot describe, spelled the same way here so core's own
 * defaults and a host's registrations reach expansion through one shape.
 */
interface CoreOptions {
  returns?: ReturnsSchema;
  captures?: readonly string[];
}

/**
 * One core default, with its implementation normalized here.
 *
 * A component that declares an authored form hands over a declaration and this
 * builds the dispatcher — in the copy of core that will perform the execution,
 * which is the whole point (`invocation-identity.ts`). A component that
 * declares nothing is form-insensitive and its function is used as it is.
 */
function core(
  name: string,
  implementation: FunctionComponent | FormDeclaration,
  props: PropsSchema,
  options: CoreOptions = {},
): [string, RegistryEntry] {
  const fn = typeof implementation === "function" ? implementation : formDispatcher(implementation);
  const { returns, captures } = options;
  return [
    name,
    {
      default: {
        definition: {
          kind: "function",
          name,
          props,
          ...(returns === undefined ? {} : { returns }),
          ...(captures === undefined ? {} : { captures }),
          fn,
        },
        origin: CORE_ORIGIN,
      },
    },
  ];
}

export const CORE_REGISTRY: ComponentRegistry = new Map<string, RegistryEntry>([
  core("Elicit", Elicit, parseJsonObject(elicitProps), {
    returns: parseJsonObject(elicitReturns),
  }),
  core("TempDir", TempDir, parseJsonObject(tempDirProps)),
  core("Fetch", Fetch, parseJsonObject(fetchProps)),
  core("File", fileForm, parseJsonObject(fileProps)),
  core("File.Delete", fileDeleteForm, parseJsonObject(fileDeleteProps)),
  core("Glob", Glob, parseJsonObject(globProps), { returns: parseJsonObject(globReturns) }),
  core("Json", Json, parseJsonObject(jsonProps), { captures: ["value"] }),
  core("Parse", Parse, parseJsonObject(parseProps), { returns: parseJsonObject(parseReturns) }),
  core("SafeParse", SafeParse, parseJsonObject(safeParseProps), {
    returns: parseJsonObject(safeParseReturns),
  }),
  core("Test", Test, parseJsonObject(testProps)),
]);

/**
 * The names core supplies, as a set.
 *
 * Derived from the registry above rather than restated, so a host deciding
 * whether a name is already core's reads the one authoritative list. They stay
 * ordinary defaults: this says which names core answers for, not which names
 * anything is forbidden to register.
 */
export const CORE_COMPONENT_NAMES: ReadonlySet<string> = new Set(CORE_REGISTRY.keys());
