/**
 * Declare the packaged review graph before a root document is imported.
 *
 * Thirty-five Markdown components cross as {@link MarkdownComponent} values
 * with packaged bytes, stable asset origins and digests. Seven TypeScript
 * components use reserved registrations. Both reserve names so the repository
 * being reviewed cannot replace its reviewers; duplicate host reservations
 * refuse at admission. Ordinary includes and component discovery remain
 * available for unreserved names.
 *
 * Assets resolve from this module's own URL in source, npm and compiled builds.
 * Read them through the Effection filesystem directly: document-facing API.Fs
 * and Files middleware must not substitute the review program. Missing assets
 * fail assembly rather than leaving an empty component reservation.
 */

import { readTextFile } from "@effectionx/fs";
import type { Operation } from "effection";
import {
  contributeDocumentation,
  documented,
  packageDocumentation,
  registerComponents,
} from "@executablemd/core";
import type {
  ComponentRegistration,
  DocumentationContribution,
  DocumentationReader,
  FunctionComponent,
} from "@executablemd/core";
// The declaration constructor and its digest are a *host* concern: they are what
// a trusted installation hands to an execution, rather than anything a document
// or a registered component reaches.
import { Markdown, sourceDigest } from "@executablemd/core/host";
import type { MarkdownComponent } from "@executablemd/core/host";

import CommentReviewData, {
  props as commentReviewDataProps,
  returns as commentReviewDataReturns,
} from "./components/CommentReviewData.ts";
import CommentReviewState, {
  props as commentReviewStateProps,
  returns as commentReviewStateReturns,
} from "./components/CommentReviewState.ts";
import Doctor, { props as doctorProps, returns as doctorReturns } from "./components/Doctor.ts";
import OxlintDiagnostics, {
  props as oxlintDiagnosticsProps,
  returns as oxlintDiagnosticsReturns,
} from "./components/OxlintDiagnostics.ts";
import RepositoryInventory, {
  props as repositoryInventoryProps,
  returns as repositoryInventoryReturns,
} from "./components/RepositoryInventory.ts";
import ReviewDiagnostics, {
  props as reviewDiagnosticsProps,
  returns as reviewDiagnosticsReturns,
} from "./components/ReviewDiagnostics.ts";
import ReviewContext, {
  props as reviewContextProps,
  returns as reviewContextReturns,
} from "./components/ReviewContext.ts";

/** The package every component in this graph reports as its source. */
export const REVIEW_ORIGIN = "@executablemd/code-review-agent";

/** Which of the two packaged document trees a component's bytes sit in. */
export type ReviewDocumentGroup = "components" | "policies";

/** One packaged Markdown component: the name a document writes, and where it lives. */
export interface ReviewDocument {
  readonly name: string;
  readonly group: ReviewDocumentGroup;
}

/**
 * Declare the packaged Markdown manifest in stable order.
 * Compiled assets cannot rely on directory enumeration. Groups also determine
 * origins, so adding or relocating a component is an explicit identity edit.
 */
export const REVIEW_DOCUMENTS: readonly ReviewDocument[] = [
  { name: "AbstractionNames", group: "components" },
  { name: "CleanupIssues", group: "components" },
  { name: "CommentReview", group: "components" },
  { name: "ConfigSourceMix", group: "components" },
  { name: "DeepInfraProvider", group: "components" },
  { name: "DescriptionCheck", group: "components" },
  { name: "EnsureOxlint", group: "components" },
  { name: "Finding", group: "components" },
  { name: "Format", group: "components" },
  { name: "GitHubAuth", group: "components" },
  { name: "GitHubComment", group: "components" },
  { name: "Instruction", group: "components" },
  { name: "LinkedIssue", group: "components" },
  { name: "NewDependencies", group: "components" },
  { name: "OllamaProvider", group: "components" },
  { name: "OxlintConfig", group: "components" },
  { name: "OxlintSignals", group: "components" },
  { name: "OxlintSummary", group: "components" },
  { name: "Pattern", group: "components" },
  { name: "PrPolicyReport", group: "components" },
  { name: "Ratio", group: "components" },
  { name: "ReleaseSpecWarning", group: "components" },
  { name: "RepoPolicyReport", group: "components" },
  { name: "ReviewSection", group: "components" },
  { name: "ReviewSetup", group: "components" },
  { name: "Sample", group: "components" },
  { name: "SuggestRemoval", group: "components" },
  { name: "ThinkFilter", group: "components" },
  { name: "Threshold", group: "components" },
  { name: "UnusedInDiff", group: "components" },
  { name: "BloatPolicy", group: "policies" },
  { name: "ExtraneousCodePolicy", group: "policies" },
  { name: "RepoCleanupPolicy", group: "policies" },
  { name: "ScopePolicy", group: "policies" },
  { name: "SlopPolicy", group: "policies" },
];

/** Where one packaged component's bytes live, as a URL beside this module. */
export function reviewDocumentUrl(document: ReviewDocument): URL {
  return new URL(`./documents/${document.group}/${document.name}.md`, import.meta.url);
}

/**
 * Identify a component by package and asset, never its host filesystem path.
 * Source, npm and compiled distributions therefore report the same origin.
 */
export function reviewDocumentOrigin(document: ReviewDocument): string {
  return `${REVIEW_ORIGIN}/${document.group}/${document.name}.md`;
}

/**
 * Read this build's packaged Markdown lazily during trusted host assembly.
 * Each assembly creates a fresh array; declaration identity is name, origin, bytes
 * and digest rather than object identity. Missing assets fail before root import.
 */
export function* reviewComponentDeclarations(): Operation<MarkdownComponent[]> {
  const declarations: MarkdownComponent[] = [];
  for (const document of REVIEW_DOCUMENTS) {
    const url = reviewDocumentUrl(document);
    let source: string;
    try {
      source = yield* readTextFile(url);
    } catch (error) {
      throw new Error(
        `the packaged review component ${document.group}/${document.name}.md is missing from ` +
          `this build (looked in ${url.href})`,
        { cause: error },
      );
    }
    declarations.push(
      Markdown({
        name: document.name,
        origin: reviewDocumentOrigin(document),
        source,
        // Stated about the bytes this build actually read, and checked against
        // them at admission. A build that shipped different bytes is refused
        // where it is installed rather than wherever a document happens to
        // write the name.
        digest: sourceDigest(source),
        // `forms` is deliberately unstated. These components accept both
        // spellings today, and a declaration that narrowed them would change
        // what the existing review roots may write.
      }),
    );
  }
  return declarations;
}

/**
 * Adapt typed implementations after the engine validates their declared schemas.
 * TypeScript cannot infer a prop type from its JSON Schema value. Keep each
 * implementation's prop type aligned with that schema; the schema remains the
 * runtime check.
 */
// deno-lint-ignore no-explicit-any
function reviewComponent(fn: (props: any) => Operation<unknown>): FunctionComponent {
  return fn;
}

/**
 * Reserve the seven TypeScript component names alongside the Markdown declarations.
 * These implementations run processes, read credentials and reach the network;
 * leaving them shadowable would let the review subject replace its own reviewers.
 * Their existing public names and contracts are retained.
 */
export const REVIEW_REGISTRATIONS: readonly ComponentRegistration[] = [
  {
    name: "CommentReviewData",
    origin: REVIEW_ORIGIN,
    reserved: true,
    props: commentReviewDataProps,
    returns: commentReviewDataReturns,
    fn: reviewComponent(CommentReviewData),
    ...documented({
      description:
        `Collect the pull request's existing review comments and replies. ` +
        `\`<CommentReviewData pr={pr} as="data" />\` prepares the pairs and prior finding ` +
        `state used by review classification.`,
      as: "The normalized review-comment pairs, previous findings, and reply groups.",
      context: null,
    }),
  },
  {
    name: "CommentReviewState",
    origin: REVIEW_ORIGIN,
    reserved: true,
    props: commentReviewStateProps,
    returns: commentReviewStateReturns,
    fn: reviewComponent(CommentReviewState),
    ...documented({
      description:
        `Build the pending review-comment update from classified review data. ` +
        `\`<CommentReviewState pr={pr} data={data} classificationResult={classification} ` +
        `sampleResult={sample} as="state" />\` decides which findings and dismissals remain.`,
      as: "The checklist text, pending findings, and new dismissal replies.",
      context: null,
    }),
  },
  {
    name: "Doctor",
    origin: REVIEW_ORIGIN,
    reserved: true,
    props: doctorProps,
    returns: doctorReturns,
    fn: reviewComponent(Doctor),
    ...documented({
      description:
        `Inspect whether the checkout is ready for review analysis. ` +
        `\`<Doctor pr={pr} as="doctor" />\` reports pinned tool availability, TypeScript ` +
        `support, analyzed files, and actionable setup guidance.`,
      as: "The checkout readiness report used by review and repository analysis.",
      context: null,
    }),
  },
  {
    name: "OxlintDiagnostics",
    origin: REVIEW_ORIGIN,
    reserved: true,
    props: oxlintDiagnosticsProps,
    returns: oxlintDiagnosticsReturns,
    fn: reviewComponent(OxlintDiagnostics),
    ...documented({
      description:
        `Run the review's pinned Oxlint sensor over selected files. ` +
        `\`<OxlintDiagnostics files={paths} typeAware as="diagnostics" />\` returns normalized ` +
        `diagnostics and fails on a sensor crash or unusable output.`,
      as: "The normalized Oxlint diagnostics for the selected files.",
      context: null,
    }),
  },
  {
    name: "ReviewDiagnostics",
    origin: REVIEW_ORIGIN,
    reserved: true,
    props: reviewDiagnosticsProps,
    returns: reviewDiagnosticsReturns,
    fn: reviewComponent(ReviewDiagnostics),
    ...documented({
      description:
        `Group normalized Oxlint diagnostics for review policies. ` +
        `\`<ReviewDiagnostics raw={rawDiagnostics} pr={pr} doctor={doctor} as="diagnostics" />\`.`,
      as: "The grouped diagnostics, categories, density, and review summary.",
      context: null,
    }),
  },
  {
    name: "RepositoryInventory",
    origin: REVIEW_ORIGIN,
    reserved: true,
    props: repositoryInventoryProps,
    returns: repositoryInventoryReturns,
    fn: reviewComponent(RepositoryInventory),
    ...documented({
      description:
        `Inventory the repository source used by repository analysis. ` +
        `\`<RepositoryInventory as="repository" />\` returns the selected paths and their file ` +
        `and line totals.`,
      as: "The selected source paths and their file and line totals.",
      context: null,
    }),
  },
  {
    name: "ReviewContext",
    origin: REVIEW_ORIGIN,
    reserved: true,
    props: reviewContextProps,
    returns: reviewContextReturns,
    fn: reviewComponent(ReviewContext),
    ...documented({
      description:
        `Build review context for the configured base and head revisions. ` +
        `\`<ReviewContext as="review" />\` returns pull-request metadata and changed file paths ` +
        `from the local Git checkout.`,
      as: "The pull-request data and changed file paths for the configured revision range.",
      context: null,
    }),
  },
];

/**
 * This boundary's long-form documentation, and the components it must cover.
 *
 * The covered set is derived from {@link REVIEW_REGISTRATIONS} rather than
 * written out again, so a registration added here demands its documentation
 * without anyone remembering to update a second list.
 *
 * The thirty-five Markdown declarations are deliberately absent from it. A
 * declared component's documentation is its own frontmatter and body — the
 * documentation index joins on a package origin, and declared Markdown names
 * none — so listing them here would demand headings for components this file
 * could not be the documentation of.
 */
export function* reviewDocumentation(
  read?: DocumentationReader,
): Operation<DocumentationContribution> {
  return yield* packageDocumentation(
    new URL("./components.md", import.meta.url),
    { owner: REVIEW_ORIGIN, asset: "packages/code-review-agent/src/components.md" },
    REVIEW_REGISTRATIONS.map((registration) => registration.name),
    read,
  );
}

/**
 * Install the seven reserved registrations and the documentation describing them.
 *
 * One call, both halves, for the reason every other package bootstrap is one
 * call: a scope that has the components has the words that describe them, and
 * two installers kept in step by hand eventually are not.
 *
 * Declarative only. Nothing here installs a provider, spawns a process, reads a
 * credential or reaches the network — which is what lets `xmd syntax` and
 * document validation enter it to describe the profile a run would have.
 *
 * The thirty-five Markdown components are not installed here: a declaration
 * crosses on an `ExecutionInstallation`, by value, rather than being registered
 * into a scope. {@link reviewComponentDeclarations} is that half.
 */
export function* useReviewComponents(): Operation<void> {
  yield* registerComponents(REVIEW_REGISTRATIONS);
  yield* contributeDocumentation(reviewDocumentation);
}
