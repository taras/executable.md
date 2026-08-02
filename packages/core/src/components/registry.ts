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
import Answers, { props as answersProps } from "./Answers.ts";
import Elicit, { props as elicitProps, returns as elicitReturns } from "./Elicit.ts";
import TempDir, { props as tempDirProps } from "./TempDir.ts";
import File, { props as fileProps } from "./File.ts";
import Glob, { props as globProps, returns as globReturns } from "./Glob.ts";
import Parse, { props as parseProps, returns as parseReturns } from "./Parse.ts";
import SafeParse, { props as safeParseProps, returns as safeParseReturns } from "./SafeParse.ts";
import { parseJsonObject } from "../json.ts";
import type { FunctionComponent, PropsSchema, ReturnsSchema } from "../types.ts";

/** The origin every core component reports to inspection. */
export const CORE_ORIGIN = "@executablemd/core";

function core(
  name: string,
  fn: FunctionComponent,
  props: PropsSchema,
  returns?: ReturnsSchema,
): [string, RegistryEntry] {
  return [
    name,
    {
      default: {
        definition: {
          kind: "function",
          name,
          props,
          ...(returns === undefined ? {} : { returns }),
          fn,
        },
        origin: CORE_ORIGIN,
      },
    },
  ];
}

export const CORE_REGISTRY: ComponentRegistry = new Map<string, RegistryEntry>([
  core("Answers", Answers, parseJsonObject(answersProps)),
  core("Elicit", Elicit, parseJsonObject(elicitProps), parseJsonObject(elicitReturns)),
  core("TempDir", TempDir, parseJsonObject(tempDirProps)),
  core("File", File, parseJsonObject(fileProps)),
  core("Glob", Glob, parseJsonObject(globProps), parseJsonObject(globReturns)),
  core("Parse", Parse, parseJsonObject(parseProps), parseJsonObject(parseReturns)),
  core("SafeParse", SafeParse, parseJsonObject(safeParseProps), parseJsonObject(safeParseReturns)),
]);
