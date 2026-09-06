/**
 * `xmd syntax` — everything a document may write here, described without
 * running any of it.
 *
 * Two jobs, kept apart. The first is entering the `run` profile's *declarative*
 * bootstraps: the same calls the runtime installers delegate to, with none of
 * the middleware, providers, launchers or activation those installers also
 * arrange. The second is rendering, and both renderers take the symbols as a
 * value — neither performs discovery, and neither parses the other's output.
 *
 * Entering the bootstraps rather than splicing their registration arrays is
 * what makes the documentation this command reads the profile's own: a package
 * installs its registrations and its documentation in one call, so a command
 * that has the components has the words that describe them. Splicing the arrays
 * left the two halves to be kept in step by hand, and they were not.
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
import { useCompositionComponents } from "@executablemd/workflow";

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
 * is no process, agent, service, journal, file or authority left to clean up.
 */
export function* syntaxSymbols(includes: readonly string[]): Operation<SyntaxSymbols> {
  return yield* scoped(function* () {
    yield* useRunProfileRegistry();
    return yield* profileSymbols(includes);
  });
}

/** The profile's symbols, inside a scope that has already bootstrapped it. */
function* profileSymbols(includes: readonly string[]): Operation<SyntaxSymbols> {
  return yield* inspectSyntax({
    includes,
    components: agentIdentityComponents(),
    // `<Plan>` is part of the run profile, so symbols that left it out would
    // describe a vocabulary no run has. Described from the packaged bytes:
    // inspection mints nothing, so it reports the Component's identity and
    // contract without building the capabilities only a run can build.
    declarations: [yield* planComponentDescription()],
  });
}

/**
 * The declarations the `run` profile installs, and nothing else.
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
export function* useRunProfileRegistry(): Operation<void> {
  yield* useVerboseComponent();
  yield* useAgentComponents();
  yield* useTestingComponents();
  yield* useWebComponents();
  // The repository-composition vocabulary.
  yield* useCompositionComponents();
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
): Operation<string> {
  return yield* scoped(function* () {
    yield* useRunProfileRegistry();
    const catalog = yield* profileSymbols(includes);
    const index = documentationIndexFor(yield* capturedDocumentation());
    return renderSelectedDocumentation(selectDocumented(catalog, catalog, names, index));
  });
}
