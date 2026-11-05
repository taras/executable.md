import { createApi } from "@effectionx/context-api";
import type { Api } from "@effectionx/context-api";
import type { Operation } from "effection";
import type { PluginInstallation } from "@executablemd/core/api";
import type { IdentityComponent } from "@executablemd/core/host";

/** Establish dependencies for one live logical REPL session. */
export interface ReplApi {
  initialize(session: { readonly workspace: string }): Operation<void>;
}

export const Repl: Api<ReplApi> = createApi<ReplApi>("executablemd.cli.repl", {
  // deno-lint-ignore require-yield
  *initialize() {},
});

/** Contribute session setup, identity components and conversation setup. */
export interface ReplPluginExtension {
  initialize?(session: { readonly workspace: string }): Operation<void>;
  readonly components?: readonly IdentityComponent[];
  sidekick?(): Operation<void>;
}

/** The CLI-owned extension of a command's Plugin installation. */
export interface ReplPluginInstallation extends PluginInstallation {
  readonly repl?: ReplPluginExtension;
}
