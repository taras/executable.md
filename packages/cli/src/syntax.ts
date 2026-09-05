/**
 * `xmd syntax` — everything a document may write here, described without
 * running any of it.
 *
 * Two jobs, kept apart. The first is assembling the `run` host profile as
 * *declarations*: the same arrays the runtime installers register, with none of
 * the middleware, providers, launchers or activation those installers also
 * arrange. The second is rendering, and both renderers take the catalog as a
 * value — neither performs discovery, and neither parses the other's output.
 *
 * JSON is the canonical, lossless projection and belongs to this command.
 * Markdown belongs to core, because a document that writes `<Syntax />` is shown
 * the same catalog in the same words: two renderings that agreed only by hand
 * would be one release away from telling an operator and an agent different
 * things about one profile.
 */

import { planComponentDescription } from "./plan-component.ts";
import { scoped } from "effection";
import type { Operation } from "effection";
import {
  AGENT_REGISTRATIONS,
  agentDocumentation,
  agentIdentityComponents,
  documentationIndexFor,
  inspectSyntax,
  registerComponents,
  renderSelectedDocumentation,
  renderSyntaxMarkdown,
  selectDocumented,
} from "@executablemd/core";
import type { DocumentationContribution, SyntaxCatalog } from "@executablemd/core";
import { TESTING_REGISTRATIONS, testingDocumentation } from "@executablemd/testing";
import { WEB_REGISTRATIONS, webDocumentation } from "@executablemd/web";
import { cliDocumentation, VERBOSE_REGISTRATION } from "./verbose-component.ts";
import { COMPOSITION_REGISTRATIONS, compositionDocumentation } from "@executablemd/workflow";

export { renderSyntaxMarkdown };

/**
 * The catalog for the production `run` profile, in the contextual working
 * directory.
 *
 * The registrations are the ones `installTestingComponents()`,
 * `installWebComponents()`, `installAgentComponents()` and the
 * repository-composition installer register, read as values so this cannot
 * drift from what a run installs. What those installers
 * *also* do — testing activation and its execution middleware, the elicitation
 * provider, the agent provider, the permission mode, the foreground launcher —
 * is operational and belongs to a run, so none of it happens here.
 *
 * `<Session>` travels as a declaration for the same reason: its factory takes
 * an execution's claimant, and describing an environment mints no execution.
 *
 * The scope is bounded, and everything installed in it is declarative registry
 * state. Leaving it removes the layer, and there is no process, agent, service,
 * journal, file or authority left to clean up.
 */
export function* syntaxCatalog(includes: readonly string[]): Operation<SyntaxCatalog> {
  return yield* scoped(function* () {
    yield* useRunProfileRegistry();
    return yield* inspectSyntax({
      includes,
      components: agentIdentityComponents(),
      // `<Plan>` is part of the run profile, so a catalog that left it out would
      // describe a vocabulary no run has. Described from the packaged bytes:
      // inspection mints nothing, so it reports the Component's identity and
      // contract without building the capabilities only a run can build.
      declarations: [yield* planComponentDescription()],
    });
  });
}

/**
 * The registrations the `run` profile installs, as registry state and nothing
 * else.
 *
 * Shared with `xmd plan`, which both describes this vocabulary to a generator
 * and validates what comes back. Registering only here would make the catalog
 * advertise `<Agent>` while validation reported it unresolved — a document told
 * to use a component nobody would accept.
 */
export function* useRunProfileRegistry(): Operation<void> {
  yield* registerComponents([
    VERBOSE_REGISTRATION,
    ...AGENT_REGISTRATIONS,
    ...TESTING_REGISTRATIONS,
    ...WEB_REGISTRATIONS,
    // The repository-composition vocabulary. Registering it is all that happens
    // here: catalog construction installs no provider, discovers no ambient
    // repository, acquires no lock, spawns no Git and reads no credential.
    ...COMPOSITION_REGISTRATIONS,
  ]);
}

/**
 * The documentation the `run` profile's own packages contribute.
 *
 * Assembled beside `useRunProfileRegistry()` and from the same declarations, so
 * a package whose components this profile registers is a package whose
 * documentation this profile demands. Core's own is added by
 * `documentationIndexFor()`; everything here is a boundary outside it.
 *
 * The list is deliberately not "whatever is installed": it is captured at the
 * trusted boundary, before any document code exists, so nothing a running
 * document reaches can add a source, remove one, or answer for what a component
 * does.
 */
export function* runProfileDocumentation(): Operation<DocumentationContribution[]> {
  // One entry per boundary `useRunProfileRegistry()` installs, in the same
  // order and from the same declarations. Core's own is added by
  // `documentationIndexFor()`; these are the boundaries outside it.
  return [
    yield* agentDocumentation(),
    yield* cliDocumentation(),
    yield* testingDocumentation(),
    yield* webDocumentation(),
    yield* compositionDocumentation(),
  ];
}

/**
 * The catalog as JSON: two-space indent, one trailing newline.
 *
 * Catalog construction owns member insertion order, category order and entry
 * order, so the bytes are the same for the same environment.
 */
export function renderSyntaxJson(catalog: SyntaxCatalog): string {
  return `${JSON.stringify(catalog, null, 2)}\n`;
}

/**
 * The selected components' metadata and long-form documentation.
 *
 * `xmd syntax Elicit` and `<Syntax names={["Elicit"]} />` are the same lookup:
 * one selection, one index, one renderer. An operator reading a terminal and an
 * agent reading a document are answering the same question, and two renderings
 * that agreed only by hand would be one release away from disagreeing.
 *
 * Nothing here narrows execution, so every entry a catalog holds is available
 * and each says so.
 */
export function* renderSyntaxDocumentation(
  catalog: SyntaxCatalog,
  names: readonly string[],
): Operation<string> {
  const index = yield* documentationIndexFor(yield* runProfileDocumentation());
  return renderSelectedDocumentation(selectDocumented(catalog, catalog, names, index));
}
