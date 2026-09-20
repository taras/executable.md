/**
 * `xmd syntax` — everything a document may write here, described without
 * running any of it.
 *
 * Two jobs, kept apart. The first is entering the command's *declarative*
 * bootstraps: the same calls the runtime installers delegate to, with none of
 * the middleware, providers, launchers or activation those installers also
 * arrange. The second is rendering, and both renderers take the symbols as a
 * value — neither performs discovery, and neither parses the other's output.
 *
 * Entering the bootstraps rather than splicing their registration arrays is
 * what makes the documentation this command reads the command's own: a package
 * installs its registrations and its documentation in one call, so a command
 * that has the components has the words that describe them. Splicing the arrays
 * left the two halves to be kept in step by hand, and they were not.
 *
 * What a Plugin contributes is not entered here at all. A Plugin installs its
 * registrations and its documentation in the command scope this one is entered
 * inside, and declares its Markdown components by value — so what the symbols
 * describe is what the command installed, and a command that installed no
 * Plugin describes exactly the engine's own language.
 *
 * JSON is the canonical, lossless projection and belongs to this command.
 * Markdown belongs to core, because a document that writes `<Syntax />` is shown
 * the same symbols in the same words: two renderings that agreed only by hand
 * would be one release away from telling an operator and an agent different
 * things about one profile.
 */

import { planComponentDescription } from "./plan-component.ts";
import { scoped } from "effection";
import type { Operation } from "effection";
import {
  agentIdentityComponents,
  capturedDocumentation,
  documentationIndexFor,
  inspectSyntax,
  renderSelectedDocumentation,
  renderSyntaxMarkdown,
  selectDocumented,
  useAgentComponents,
} from "@executablemd/core";
import type { SyntaxSymbols } from "@executablemd/core";
import { useTestingComponents } from "@executablemd/testing";
import { useWebComponents } from "@executablemd/web";
import { useVerboseComponent } from "./verbose-component.ts";
import type { ExecutionDeclaration } from "@executablemd/core/host";
import { NO_PLUGINS } from "./plugin-host.ts";
import type { CommandPlugins } from "./plugin-host.ts";

export { renderSyntaxMarkdown };

/**
 * The symbols for the production `run` profile, in the contextual working
 * directory.
 *
 * The declarations are the ones `installTestingComponents()`,
 * `installWebComponents()`, `installAgentComponents()` and the
 * repository-composition installer each delegate to, entered here directly so
 * this cannot drift from what a run installs. What those installers *also* do —
 * testing activation and its execution middleware, the elicitation provider,
 * the agent provider, the permission mode, the foreground launcher — is
 * operational and belongs to a run, so none of it happens here.
 *
 * `<Session>` travels as a declaration for the same reason: its factory takes
 * an execution's claimant, and describing an environment mints no execution.
 *
 * The scope is bounded, and everything installed in it is declarative registry
 * state and documentation middleware. Leaving it removes the layer, and there
 * is no process, agent, service, journal, file or permission left to clean up.
 */
export function* syntaxSymbols(
  includes: readonly string[],
  plugins: CommandPlugins = NO_PLUGINS,
): Operation<SyntaxSymbols> {
  return yield* scoped(function* () {
    yield* useCommandComponents();
    return yield* profileSymbols(includes, plugins);
  });
}

/** The profile's symbols, inside a scope that has already bootstrapped it. */
function* profileSymbols(
  includes: readonly string[],
  plugins: CommandPlugins,
): Operation<SyntaxSymbols> {
  return yield* inspectSyntax({
    includes,
    components: agentIdentityComponents(),
    // `<Plan>` is part of the run profile, so symbols that left it out would
    // describe a vocabulary no run has. Described from the packaged bytes:
    // inspection mints nothing, so it reports the Component's identity and
    // contract without building the capabilities only a run can build.
    declarations: commandDeclarations(plugins, yield* planComponentDescription()),
  });
}

/**
 * Everything this command declares, in one order.
 *
 * Every execution declaration the selected Plugins contributed — exact Markdown
 * components *and* structural syntax, on one list under one discriminant —
 * followed by whatever the calling surface declares for itself. Both arms,
 * because both are what a name means here: a catalog carrying only the Markdown
 * half would describe a language a run does not have, and a Plan writing a
 * construct the run expands would be refused for writing syntax nobody had
 * heard of.
 *
 * Built here rather than at each site for the reason the registry bootstrap is:
 * four places assemble this vocabulary — an ordinary run, a nested
 * `host="run"` child, inspection, and `<Plan>`'s validation — and a list
 * spelled four times is four chances for one of them to describe a vocabulary
 * the others do not have. A document validated against a profile it will not
 * run under is the specific failure that costs an agent a whole authoring
 * round.
 *
 * The order is fixed rather than incidental. Nothing depends on it for
 * resolution — two declarations claiming one name is refused at admission
 * rather than settled by position — but a stable order makes a catalog's bytes
 * stable, which is what lets a source run and a compiled run be compared
 * directly.
 */
export function commandDeclarations(
  plugins: CommandPlugins,
  ...own: readonly ExecutionDeclaration[]
): ExecutionDeclaration[] {
  return [...plugins.declarations, ...own];
}

/**
 * The declarative vocabulary every command installs, and nothing else.
 *
 * Shared with `xmd plan`, which both describes this vocabulary to a generator
 * and validates what comes back. Bootstrapping only here would make the symbols
 * advertise `<Agent>` while validation reported it unresolved — a document told
 * to use a component nobody would accept.
 *
 * Each call is one package's declarative bootstrap: its registrations and the
 * documentation that describes them. None of them installs a provider,
 * discovers an ambient repository, acquires a lock, spawns Git or reads a
 * credential.
 */
export function* useCommandComponents(): Operation<void> {
  yield* useVerboseComponent();
  yield* useAgentComponents();
  yield* useTestingComponents();
  yield* useWebComponents();
  // No package-specific vocabulary is bootstrapped here — not the review
  // graph's six reserved registrations, and not the repository-composition
  // vocabulary either. What a Plugin registers it registers in the command
  // scope this one is entered inside, so what a command describes is exactly
  // the engine's own language plus whatever its profile installed.
}

/**
 * The symbols as JSON: two-space indent, one trailing newline.
 *
 * Construction owns member insertion order, category order and entry order, so
 * the bytes are the same for the same environment.
 */
export function renderSyntaxJson(symbols: SyntaxSymbols): string {
  return `${JSON.stringify(symbols, null, 2)}\n`;
}

/**
 * The selected components' metadata and long-form documentation.
 *
 * `xmd syntax Elicit` and `<Syntax names={["Elicit"]} />` are the same lookup:
 * one selection, one index, one renderer. An operator reading a terminal and an
 * agent reading a document are answering the same question, and two renderings
 * that agreed only by hand would be one release away from disagreeing.
 *
 * The symbols and the index come from *one* entry into the profile's
 * bootstraps, inside this scope. Building them from two entries would let the
 * command describe a component from one assembly and document it from another;
 * building the index outside the scope would find no contribution at all, since
 * a bootstrap's documentation belongs to the scope that entered it.
 *
 * Nothing here narrows execution, so every entry the symbols hold is available
 * and each says so.
 */
export function* renderSyntaxDocumentation(
  includes: readonly string[],
  names: readonly string[],
  plugins: CommandPlugins = NO_PLUGINS,
): Operation<string> {
  return yield* scoped(function* () {
    yield* useCommandComponents();
    const catalog = yield* profileSymbols(includes, plugins);
    const index = documentationIndexFor(yield* capturedDocumentation());
    return renderSelectedDocumentation(selectDocumented(catalog, catalog, names, index));
  });
}
