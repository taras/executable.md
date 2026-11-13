import { dirname, join, resolve } from "node:path";
import type { Operation } from "effection";
import type { Plugin } from "@executablemd/core/api";
import { cwd, lstat, readTextFile, realpath, stat } from "@executablemd/runtime";
import { z } from "zod";
import type { CommandPlugins } from "./plugin-host.ts";
import { installPlugins } from "./plugin-host.ts";
import type { PluginModuleLoader } from "./plugin-loader.ts";
import { loadPlugins } from "./plugin-loader.ts";
import type { PluginSelection } from "./plugin-selection.ts";
import { describeError } from "./props.ts";
import { BUNDLED_SELECTOR } from "./run-profile.ts";

const packageConfig = z.object({
  test: z.object({ plugins: z.array(z.string().min(1)).optional() }).optional(),
});

function* findConfig(document: string): Operation<string | undefined> {
  let directory = dirname((yield* realpath(document)) ?? document);
  while (true) {
    const config = join(directory, "xmd.json");
    if ((yield* lstat(config)).exists) {
      return config;
    }
    const parent = dirname(directory);
    if (directory === parent || (yield* stat(join(directory, "package.json"))).isFile) {
      return undefined;
    }
    directory = parent;
  }
}

function* loadConfiguredPlugins(
  config: string | undefined,
  load: PluginModuleLoader,
): Operation<readonly Plugin[]> {
  if (config === undefined) {
    return [];
  }
  try {
    const source = yield* readTextFile(config);
    const parsed = packageConfig.parse(JSON.parse(source));
    return yield* loadPlugins(parsed.test?.plugins ?? [], dirname(config), load);
  } catch (error) {
    throw new Error(`${config}: ${describeError(error)}`, { cause: error });
  }
}

/** Install the selected Plugins in the caller's document scope. */
export function* installTestPlugins(
  document: string,
  selection: PluginSelection,
  load: PluginModuleLoader,
): Operation<CommandPlugins> {
  const directory = yield* cwd();
  const config = yield* findConfig(resolve(directory, document));
  const configured = yield* loadConfiguredPlugins(config, load);
  const explicit = yield* loadPlugins(
    selection.specifiers.filter((specifier) => specifier !== BUNDLED_SELECTOR),
    directory,
    load,
  );
  return yield* installPlugins([...configured, ...explicit], {
    command: "test",
    args: selection.args,
  });
}
