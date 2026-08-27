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
import { declaredForms, formDispatcher } from "../invocation-identity.ts";
import { documented } from "./documentation.ts";
import type { FirstPartyDocumentation } from "./documentation.ts";
import type {
  FormDeclaration,
  FunctionComponent,
  InvocationForm,
  PropsSchema,
  ReturnsSchema,
} from "../types.ts";

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
  /**
   * The forms this component accepts, when it is form-sensitive without being
   * a dispatcher.
   *
   * A component that hands over a `FormDeclaration` needs none of this: its
   * forms are read off that declaration below. This is for one that refuses a
   * form in its own body — `<Json>`, which will not render content — so what it
   * accepts and what it says it accepts are still written once each and agree.
   */
  forms?: readonly InvocationForm[];
}

/**
 * One core default, with its implementation normalized here.
 *
 * A component that declares an authored form hands over a declaration and this
 * builds the dispatcher — in the copy of core that will perform the execution,
 * which is the whole point (`invocation-identity.ts`). A component that
 * declares nothing is form-insensitive and its function is used as it is.
 *
 * The accepted forms are read off that same declaration rather than restated,
 * so `<File>`'s two bodies and `<File.Delete>`'s one are documented by the value
 * that dispatches them. Documentation is a parameter rather than an option
 * because a core default states what it is for, and says explicitly whether
 * `as` and content apply to it.
 */
function core(
  name: string,
  implementation: FunctionComponent | FormDeclaration,
  props: PropsSchema,
  documentation: FirstPartyDocumentation,
  options: CoreOptions = {},
): [string, RegistryEntry] {
  const declaration = typeof implementation === "function" ? undefined : implementation;
  const fn = typeof implementation === "function" ? implementation : formDispatcher(implementation);
  const { returns, captures } = options;
  const forms = declaration === undefined ? options.forms : declaredForms(declaration);
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
          ...(forms === undefined ? {} : { forms }),
          ...documented(documentation),
          fn,
        },
        origin: CORE_ORIGIN,
      },
    },
  ];
}

export const CORE_REGISTRY: ComponentRegistry = new Map<string, RegistryEntry>([
  core(
    "Elicit",
    Elicit,
    parseJsonObject(elicitProps),
    {
      description:
        'Ask a person a structured question. `<Elicit schema={decision} as="answer">…</Elicit>` ' +
        "shows the content as the request.",
      as: "Required. The validated answer, as a structured value.",
      context: "The request message the person is shown.",
    },
    { returns: parseJsonObject(elicitReturns) },
  ),
  core("TempDir", TempDir, parseJsonObject(tempDirProps), {
    description:
      "Run work in a temporary working directory. `<TempDir>…</TempDir>` expands its content " +
      "with the temporary directory as the working directory, so `<File>` and commands inside " +
      "write there rather than in the current one. `<TempDir />` renders the path instead.",
    as: "Optional. Captures the rendered directory path instead of emitting it.",
    context: "Markdown expanded with the temporary directory as its working directory.",
  }),
  core("Fetch", Fetch, parseJsonObject(fetchProps), {
    description:
      'Fetch a URL. `<Fetch url="https://example.com/status" as="response" />` binds the ' +
      "response, and any status is data you can branch on. Without `as`, a non-2xx status " +
      "fails. Only GET and HEAD methods currently supported.",
    as:
      "Optional. Captures the response, which is what makes a non-2xx status data instead " +
      "of a failure.",
    context: null,
  }),
  core("File", fileForm, parseJsonObject(fileProps), {
    description:
      'Read or write a file. `<File path="notes.md" />` reads the content; ' +
      '`<File path="notes.md">…</File>` writes the content. The path is relative to the ' +
      "working directory.",
    as: "Optional. Captures the file's text instead of emitting it, in the reading form.",
    context: "The text to write, in the writing form.",
  }),
  core("File.Delete", fileDeleteForm, parseJsonObject(fileDeleteProps), {
    description:
      'Delete a file. `<File.Delete path="notes.md" />` removes it. It does not error if the ' +
      "file doesn't exist, and produces no output.",
    as: "Optional. Captures the empty string this renders, as for any text component.",
    context: null,
  }),
  core(
    "Glob",
    Glob,
    parseJsonObject(globProps),
    {
      description:
        'List files by pattern. `<Glob include={["**/*.md"]} as="docs" />` matches paths ' +
        "relative to the working directory. The list is sorted. Directories and symbolic " +
        "links are never results.",
      as: "Required. The matched paths, as a string array.",
      context: null,
    },
    { returns: parseJsonObject(globReturns) },
  ),
  core(
    "Json",
    Json,
    parseJsonObject(jsonProps),
    {
      description:
        "Render a value as JSON text. `<Json value={config} />` writes the JSON where you " +
        "put it.",
      as: null,
      context: null,
    },
    { captures: ["value"], forms: ["self-closing"] },
  ),
  core(
    "Parse",
    Parse,
    parseJsonObject(parseProps),
    {
      description: "Parse a value using a JSON schema. Errors on invalid content.",
      as: "Required. The validated value.",
      context: "The JSON text to parse.",
    },
    { returns: parseJsonObject(parseReturns) },
  ),
  core(
    "SafeParse",
    SafeParse,
    parseJsonObject(safeParseProps),
    {
      description: "Parse a value using a JSON schema. Binds a result object instead of erroring.",
      as: "Required. The result: either the validated value or the issues that rejected it.",
      context: "The JSON text to parse.",
    },
    { returns: parseJsonObject(safeParseReturns) },
  ),
  core("Test", Test, parseJsonObject(testProps), {
    description:
      'Define a test. `<Test name="parses a manifest">…</Test>` runs under `xmd test`, or ' +
      "inside a `<Testing>` region; elsewhere it is skipped. A failing command or assertion " +
      "inside fails the test rather than the document.",
    as: null,
    context: "The body of the test: its assertions and the work they judge.",
  }),
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
