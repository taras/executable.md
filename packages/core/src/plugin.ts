/**
 * The Plugin boundary: trusted code a distribution bundles or an operator
 * selects, installed once before an execution imports a root document.
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
 * is no permission boundary here and none is implied: a selected Plugin is code
 * the operator chose to run, with exactly the authority the `xmd` process has.
 * The engine refuses a *malformed* Plugin before installing anything; it does
 * not constrain a well-formed one.
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

/** What a value that is not a usable Plugin failed to be. */
function refusal(detail: string): Error {
  return new Error(`a Plugin module's default export ${detail}`);
}

/** The shape `install` has, read the way a function component's default is. */
function isInstall(value: unknown): value is PluginInstall {
  return typeof value === "function";
}

/** The optional half of a Plugin, named so the guard above can state it. */
type PluginInstall = (request: PluginInstallRequest) => Operation<PluginInstallation | undefined>;

/**
 * Read an untyped module export as a Plugin, or say why it is not one.
 *
 * The rule is structural and minimal, because the contract is: an object with a
 * non-empty string `name`, and either no `install` member or a callable one. A
 * value that satisfies it is used as it was loaded — copied nowhere, frozen
 * nowhere, and asked for nothing else. What `install` returns is admitted where
 * the declarations it carries are, not here.
 */
export function parsePluginValue(value: unknown): Result<Plugin> {
  if (typeof value !== "object" || value === null) {
    return Err(refusal("is a Plugin value; this module exports none"));
  }
  const name = "name" in value ? value.name : undefined;
  if (typeof name !== "string" || name.length === 0) {
    return Err(refusal("carries a non-empty string `name`"));
  }
  const install = "install" in value ? value.install : undefined;
  if (install === undefined) {
    return Ok({ name });
  }
  if (!isInstall(install)) {
    return Err(refusal(`carries a callable \`install\`, and ${name} carries ${typeof install}`));
  }
  return Ok({ name, install: (request: PluginInstallRequest) => install(request) });
}
