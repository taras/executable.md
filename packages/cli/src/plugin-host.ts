/**
 * Installing the Plugins one command runs with.
 *
 * The modules the operator selected, in the order they wrote them, and nothing
 * else: XMD ships no Plugin and installs none by default, so a command that
 * named none installs none. That order fixes how middleware composes — the
 * first Plugin installed is the outermost wrapper — and decides nothing else:
 * two Plugins claiming one name, one component name or one structural construct
 * are refused rather than settled by position.
 *
 * Installation happens once per command, in the scope that encloses everything
 * the command does. A Plugin that installed middleware, acquired a resource or
 * started something has it for exactly as long as the command runs, and a
 * failure part-way through the list unwinds what the earlier Plugins installed
 * before anything reads a root document.
 */

import type { Operation } from "effection";

import { ActivePlugins } from "@executablemd/core/api";
import type { Plugin, PluginInstallRequest } from "@executablemd/core/api";
import type { ExecutionDeclaration, ExecutionInstallation } from "@executablemd/core/host";

/**
 * What one command's Plugins contributed, retained for every consumer of it.
 *
 * One assembly per command. `xmd plan` asks the same value for the symbols it
 * shows a writer, for each draft check, for admission and for final validation,
 * so those four cannot describe four different vocabularies; a nested
 * `host="run"` child reinstalls the Plugin *values*, because a child runs in an
 * isolated scope and inherits no middleware.
 */
export interface CommandPlugins {
  /** The active Plugin values, in installation order. */
  readonly plugins: readonly Plugin[];
  /** What the installs contributed, as one execution installation each. */
  readonly installations: readonly ExecutionInstallation[];
  /**
   * Everything the installs declared, in the same order, under one discriminant.
   *
   * Both arms, because both are what a name means here: exact Markdown and
   * structural syntax cross on one `declarations` list to an execution, and
   * every surface that describes or validates this vocabulary reads the same
   * catalog. Retaining only the Markdown half would let `xmd syntax` and
   * `<Plan>`'s validation describe a language a run does not have — a Plugin's
   * construct would be unknown syntax to the check and ordinary syntax to the
   * run that follows it.
   */
  readonly declarations: readonly ExecutionDeclaration[];
  /**
   * The original argv these Plugins were installed from.
   *
   * Retained because a nested `host="run"` child installs the same values again
   * in its own scope, and an install request is the command and the argv the
   * invocation was written on — never a second reading of either.
   */
  readonly args: readonly string[];
}

/** An assembly that contributes nothing, for a command that installs none. */
export const NO_PLUGINS: CommandPlugins = Object.freeze({
  plugins: Object.freeze([]),
  installations: Object.freeze([]),
  declarations: Object.freeze([]),
  args: Object.freeze([]),
});

/** What two selections claiming one Plugin name are refused with. */
function duplicate(name: string): Error {
  return new Error(
    `two selected Plugins are named ${name}. A Plugin name identifies one Plugin to this ` +
      "command, so the selection is refused before any of them is installed.",
  );
}

/**
 * Refuse a selection that names one Plugin twice.
 *
 * Before any `install()` and before the root document is read. Module top-level
 * code has already run by then — loading is running — so what this guarantees
 * is that no Plugin installed anything and no document began.
 */
export function admitPlugins(plugins: readonly Plugin[]): readonly Plugin[] {
  const names = new Set<string>();
  for (const plugin of plugins) {
    if (names.has(plugin.name)) {
      throw duplicate(plugin.name);
    }
    names.add(plugin.name);
  }
  return Object.freeze([...plugins]);
}

/**
 * Install the complete list for one command, in order.
 *
 * `ActivePlugins` is installed with the whole frozen list *before* the first
 * `install()` runs, so every Plugin and every later consumer reads the same
 * list — including the first one, which would otherwise see a list it is not in.
 */
export function* installPlugins(
  selected: readonly Plugin[],
  request: PluginInstallRequest,
): Operation<CommandPlugins> {
  const plugins = admitPlugins(selected);
  yield* ActivePlugins.around({ plugins: () => plugins });

  const installations: ExecutionInstallation[] = [];
  const declared: ExecutionDeclaration[] = [];
  for (const plugin of plugins) {
    if (plugin.install === undefined) {
      continue;
    }
    const installed = yield* plugin.install(request);
    if (installed === undefined) {
      continue;
    }
    // Copied here, while the value is the one the Plugin returned: the arrays
    // belong to whoever built them, and what canonical execution captures must
    // be what this command read.
    const components = Object.freeze([...(installed.components ?? [])]);
    const structural = Object.freeze([...(installed.structural ?? [])]);
    const admissions = Object.freeze([...(installed.admissions ?? [])]);
    const expand = installed.expand;
    const declarations = [...components, ...structural];
    declared.push(...declarations);
    if (declarations.length === 0 && admissions.length === 0 && expand === undefined) {
      continue;
    }
    installations.push({
      ...(declarations.length === 0 ? {} : { declarations }),
      ...(admissions.length === 0 ? {} : { admissions }),
      // Bound to the installation it came from, so a handler reading its own
      // closure reads the one it was returned with.
      ...(expand === undefined ? {} : { expand: (call) => expand.call(installed, call) }),
    });
  }
  return {
    plugins,
    installations: Object.freeze(installations),
    declarations: Object.freeze(declared),
    args: request.args,
  };
}
