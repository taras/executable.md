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
        "Asks a person a structured question and binds their validated answer. The document " +
        "says what it is asking and what shape the answer must have; where the asking happens " +
        "is the host's decision, and an enclosing `<Answers>` region can supply the answer " +
        "instead so nobody is asked.",
      as: "Required. The validated answer, as a structured value.",
      context: "The request message the person is shown.",
    },
    { returns: parseJsonObject(elicitReturns) },
  ),
  core("TempDir", TempDir, parseJsonObject(tempDirProps), {
    description:
      "Supplies an isolated temporary directory. Written with content it is the contextual " +
      "working directory everything inside observes, removed when that content finishes; " +
      "written self-closing it renders the path and is removed with the surrounding scope.",
    as: "Optional. Captures the rendered directory path instead of emitting it.",
    context: "Markdown expanded with the temporary directory as its working directory.",
  }),
  core("Fetch", Fetch, parseJsonObject(fetchProps), {
    description:
      "Performs one authorized HTTP read and retains it. Only GET and HEAD are admitted, " +
      "because an interruption before the record commits may repeat the request. A captured " +
      "response is data whatever its status; an uncaptured one succeeds on 2xx and fails " +
      "otherwise.",
    as:
      "Optional. Captures the response, which is what makes a non-2xx status data instead " +
      "of a failure.",
    context: null,
  }),
  core("File", fileForm, parseJsonObject(fileProps), {
    description:
      "Reads and writes UTF-8 text inside the contextual working directory. Self-closing it " +
      "reads the file at `path`; paired it writes what its content rendered there.",
    as: "Optional. Captures the file's text instead of emitting it, in the reading form.",
    context: "The text to write, in the writing form.",
  }),
  core("File.Delete", fileDeleteForm, parseJsonObject(fileDeleteProps), {
    description:
      "Removes one file inside the contextual working directory. Absence is success, so " +
      "deleting a path twice succeeds twice. It renders nothing and reports nothing about " +
      "what was there.",
    as: "Optional. Captures the empty string this renders, as for any text component.",
    context: null,
  }),
  core(
    "Glob",
    Glob,
    parseJsonObject(globProps),
    {
      description:
        "Binds the regular files under the contextual working directory that a set of patterns " +
        "selects, as relative POSIX paths, deduplicated and sorted by code point. A symbolic " +
        "link is never a result and a link to a directory is never descended into.",
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
        "Renders a structured value as JSON text at the position it is written. There is no " +
        "indent, replacer or sorting option: the whole transformation is one value to one " +
        "piece of text. It renders the value it is given rather than content, so the paired " +
        "form is refused.",
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
      description:
        "Binds its content as a JSON value validated against a schema. The schema compiles " +
        "before the content expands, so an unusable schema fails before any work it would " +
        "judge. Malformed JSON and a rejected instance fail the invocation.",
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
      description:
        "Binds its content as a result a document can inspect. Same compiler and ordering as " +
        "`<Parse>`; malformed JSON and a rejected instance become a value the document can " +
        "branch on rather than a failure.",
      as: "Required. The result: either the validated value or the issues that rejected it.",
      context: "The JSON text to parse.",
    },
    { returns: parseJsonObject(safeParseReturns) },
  ),
  core("Test", Test, parseJsonObject(testProps), {
    description:
      "One test. Its invocation contains a checked command failure, so a failing command " +
      "inside it is that test's outcome rather than the document's. What a test does, and " +
      "whether it may run at all, come from the testing host.",
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
