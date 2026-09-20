/**
 * The profile a command runs with: one bundled Plugin, then whatever the
 * operator named.
 *
 * XMD ships exactly one Plugin — `@executablemd/git` — and activates it for
 * every command that executes or describes a document. It is statically
 * imported rather than loaded, so the distribution carries it whole and no
 * resolution can substitute it. Explicit `--plugin` selections follow it in the
 * order they were written, which fixes how middleware composes: the bundled
 * value is the outermost wrapper.
 *
 * ## The reserved selector
 *
 * `--plugin git` names the value this profile already carries. It is resolved
 * here, without loading a module, and writing it once or five times leaves the
 * profile exactly as it was: Git appears once, first. That is a property of the
 * *host's own selector for its own bundled value*, and of nothing else — a
 * module that merely claims the same Plugin name is a duplicate like any other,
 * and `admitPlugins()` refuses it before anything installs.
 *
 * ## What this is not
 *
 * It is not a change to the installer. `installPlugins()` and `NO_PLUGINS`
 * remain what they were: a generic primitive that installs the list it is
 * handed, and an empty assembly. Which Plugins a *command* runs with is this
 * module's business, and assembling them is all it does.
 */

import type { Operation } from "effection";
import { cwd } from "@executablemd/runtime";
import { gitPlugin, gitPluginDeclaresFor } from "@executablemd/git";
import type { Plugin } from "@executablemd/core/api";
import { loadPlugins, type PluginModuleLoader } from "./plugin-loader.ts";
import type { PluginSelection } from "./plugin-selection.ts";

/**
 * The selector that names the bundled Plugin.
 *
 * Short, and reserved: an operator writing it is referring to what the profile
 * already has rather than asking for a module to be found. Nothing resolves it
 * on a filesystem or a registry, so no package by this name can take its place.
 */
export const BUNDLED_SELECTOR = "git";

/** The Plugin every run-profile command begins with. */
export const BUNDLED_PLUGIN: Plugin = gitPlugin;

/**
 * Whether this command line runs with the bundled profile.
 *
 * Asked of the Plugin rather than listed here, because the answer is the
 * Plugin's: `run`, `plan` and `syntax` execute or describe a document outright,
 * and `workflow` reaches one only through `start`, `resume` or `fork`. A
 * management action reads or lists runs and executes nothing, so the value does
 * not belong in its profile at all — carrying it where it declares nothing
 * would still put it in `ActivePlugins`, and being in that list is what having
 * the default prefix means.
 *
 * `xmd test` answers false for the same reason: the test root is a different
 * profile, and a nested `<Execution host="run">` child assembles this one for
 * itself rather than inheriting it.
 */
export function carriesBundledPlugin(selection: PluginSelection): boolean {
  return gitPluginDeclaresFor({ command: selection.command, args: selection.args });
}

/**
 * The Plugin values one command runs with, in installation order.
 *
 * The bundled value first when this command's profile carries it, then the
 * operator's own in the order they were written, with every occurrence of the
 * reserved selector resolved to the value already present rather than loaded.
 */
export function* assembleRunProfile(
  selection: PluginSelection,
  load: PluginModuleLoader,
): Operation<readonly Plugin[]> {
  const bundled = carriesBundledPlugin(selection);
  // Resolved before anything is loaded: the reserved selector names a value
  // this profile holds, so it is never handed to a module loader, and a command
  // whose profile does not carry the bundled Plugin cannot conjure one by
  // writing the selector either.
  const named = selection.specifiers.filter((specifier) => specifier !== BUNDLED_SELECTOR);
  if (named.length === 0) {
    return bundled ? Object.freeze([BUNDLED_PLUGIN]) : Object.freeze([]);
  }
  // Captured before the first module is loaded, so a relative path and a
  // package specifier both resolve where the caller is standing.
  const directory = yield* cwd();
  const loaded = yield* loadPlugins(named, directory, load);
  return Object.freeze(bundled ? [BUNDLED_PLUGIN, ...loaded] : [...loaded]);
}

/**
 * The profile a nested `<Execution host="run">` child runs with.
 *
 * The bundled value first, then whatever the outer command had selected. The
 * prefix is added here rather than inherited, because the root may not have had
 * it: `xmd test` is not a run profile, and a child does not inherit what its
 * parent declined.
 *
 * The bundled value is dropped from the outer list **by identity**. What may be
 * dropped is the one object this host statically bundled — an operator who
 * wrote the reserved selector is holding exactly that value, and prefixing it
 * twice would be the host duplicating itself. A *different* Plugin that merely
 * claims the same name is not this value, is not dropped, and meets
 * `admitPlugins()`'s duplicate-name refusal like any other collision. Comparing
 * names here would have let an impostor disappear instead of collide.
 */
export function nestedRunProfile(outer: readonly Plugin[]): readonly Plugin[] {
  return Object.freeze([BUNDLED_PLUGIN, ...outer.filter((plugin) => plugin !== BUNDLED_PLUGIN)]);
}
