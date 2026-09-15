/**
 * The Plugin boundary: trusted code an operator selects, installed once
 * before an execution imports a root document.
 *
 * XMD ships none and defaults to none. A command that selects no Plugin
 * installs no Plugin, and a package that happens to be installed stays inert
 * until it is named.
 *
 * A Plugin is a plain structural value. It carries a name and, optionally, one
 * `install` operation. Everything else about it — what it declares, what it
 * expands, what it requires of a retained history, what middleware it composes
 * — happens inside that call, in the scope the host installs it in.
 *
 * Structural rather than branded, because a Plugin is ordinarily loaded from a
 * module that resolved its own copy of this package. A brand, a symbol or an
 * `instanceof` check would split that copy from canonical core and silently
 * drop every Plugin a separate installation produced.
 *
 * ## Trusted, not sandboxed
 *
 * Selecting a Plugin runs its module's top level and then its `install`. There
 * is no permission boundary here and none is implied: selected Plugin code can
 * execute whatever the surrounding runtime permits. The engine refuses a
 * *malformed* Plugin before installing anything; it does not constrain a
 * well-formed one.
 */

import type { Operation, Result } from "effection";
import { Err, Ok } from "effection";

import type { MarkdownComponent } from "./components/declared-markdown.ts";
import type { ExpansionRequest, Structural } from "./execution-declarations.ts";
import type { JournalAdmission } from "./execute.ts";

/**
 * What one command tells a Plugin about the invocation installing it.
 *
 * `command` is the normalized public top-level command — `run`, `plan`, `test`,
 * `syntax`, `upgrade` or `workflow` — with the shorthand document form reported
 * as `run`. It is the whole of what most Plugins need: a Plugin decides whether
 * it is active for this command and returns nothing when it is not.
 *
 * `args` is a frozen copy of the original argv, taken before Plugin selection
 * or any other scanner removed a token from it. A Plugin whose decision the top
 * level cannot carry reads the command line it was actually invoked on rather
 * than being handed an untyped bag of somebody else's parsed values.
 */
export interface PluginInstallRequest {
  readonly command: string;
  readonly args: readonly string[];
}

/**
 * What one Plugin contributes to one command's execution, declaratively.
 *
 * Returning `undefined` from `install` contributes none of this. It does not
 * create a hidden profile and it does not undo middleware the same call already
 * installed: a Plugin that means to be inactive for a command installs nothing
 * in it.
 */
export interface PluginInstallation {
  /** Exact Markdown this Plugin declares to the execution. */
  readonly components?: readonly MarkdownComponent[];
  /** Structural syntax this Plugin declares to the execution. */
  readonly structural?: readonly Structural[];
  /** How this Plugin expands the structural syntax it declared. */
  expand?(request: ExpansionRequest): Operation<void>;
  /** What this Plugin requires of a retained history before it is replayed. */
  readonly admissions?: readonly JournalAdmission[];
}

/**
 * One Plugin: a name, and what installing it does.
 *
 * The name identifies the Plugin to an operator and to the refusal that reports
 * two selections claiming it. It is not a package identity, a version or a
 * capability: nothing resolves a name to a module, and nothing grants a Plugin
 * anything for being called one thing rather than another.
 */
export interface Plugin {
  readonly name: string;
  install?(request: PluginInstallRequest): Operation<PluginInstallation | undefined>;
}

/**
 * The canonical constructor: what a Plugin module's default export is written
 * with.
 *
 * Type-preserving and nothing more. It adds no identity, no version, no profile
 * and no capability bag, and it validates nothing — a value loaded from an
 * untyped module is admitted by {@link parsePluginValue}, at the boundary that
 * loaded it.
 */
export function Plugin(input: Plugin): Plugin {
  return input;
}

/** The optional half of a Plugin, named so the guard below can state it. */
type PluginInstall = (request: PluginInstallRequest) => Operation<PluginInstallation | undefined>;

/** The shape `install` has, read the way a function component's default is. */
function isInstall(value: unknown): value is PluginInstall {
  return typeof value === "function";
}

/**
 * Whether a value satisfies the Plugin contract structurally.
 *
 * The one decision, so admission and the sentence explaining a refusal cannot
 * come to disagree about what a Plugin is: an object with a non-empty string
 * `name`, and either no `install` member or a callable one.
 */
function isPlugin(value: unknown): value is Plugin {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const name = "name" in value ? value.name : undefined;
  if (typeof name !== "string" || name.length === 0) {
    return false;
  }
  const install = "install" in value ? value.install : undefined;
  return install === undefined || isInstall(install);
}

/**
 * Why a value is not a Plugin — asked only after {@link isPlugin} said no.
 *
 * It names the member that failed and what was found there, and nothing else
 * about the module: a specifier and a member are what makes a refusal
 * actionable, and a module's internals are not a diagnostic.
 */
function refusal(value: unknown): Error {
  const detail = describe(value);
  return new Error(`a Plugin module's default export ${detail}`);
}

function describe(value: unknown): string {
  if (typeof value !== "object" || value === null) {
    return "is a Plugin value; this module exports none";
  }
  const name = "name" in value ? value.name : undefined;
  if (typeof name !== "string" || name.length === 0) {
    return "carries a non-empty string `name`";
  }
  const install = "install" in value ? value.install : undefined;
  return `carries a callable \`install\`, and ${name} carries ${typeof install}`;
}

/**
 * Read an untyped module export as a Plugin, or say why it is not one.
 *
 * What comes back on success is **the admitted value itself**, never a copy of
 * it. Two consequences the copy did not have: a Plugin may carry members this
 * boundary does not read — its own helpers, its own configuration, whatever a
 * package publishes beside the contract — and they survive; and `install` runs
 * with the receiver its own module gave it, so an implementation written as a
 * method and reading `this` behaves here exactly as it does when its package
 * calls it. Admission decides whether a value is a Plugin. It does not decide
 * what one is made of.
 */
export function parsePluginValue(value: unknown): Result<Plugin> {
  return isPlugin(value) ? Ok(value) : Err(refusal(value));
}
