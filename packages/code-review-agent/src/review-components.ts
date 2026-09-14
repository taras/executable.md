/**
 * The review and repository-analysis component graph, as this package declares
 * it to one execution.
 *
 * The components a review runs used to live in `.reviews/components/` and
 * `.reviews/policies/`, and every entrypoint reached them with `--include`. That
 * made the graph a property of the checkout being reviewed: a pull request could
 * add a file called `Finding.md` and the review would run the branch's own copy
 * while reporting on it. A review is exactly the program that must not be
 * answerable by its subject, so the graph moved here, into the installation, and
 * the host hands it to each execution before any document code exists.
 *
 * ## Two tiers, one claim
 *
 * Thirty-five of the components are Markdown, and each crosses as a
 * {@link MarkdownComponent}: the exact packaged bytes, a stable origin naming
 * the asset rather than a path, and the digest of what this build shipped. Six
 * are TypeScript, and each crosses as a **reserved** registration. The two
 * mechanisms differ in what they carry; they agree in what they mean — the host
 * is claiming the name rather than offering a default for it, so a repository
 * file of the same name does not win, and does not silently lose either: a
 * second claim on one name is refused at admission, before the root document is
 * imported.
 *
 * What this does *not* do is disable ordinary component discovery. A caller's
 * `--include` and a repository's own components resolve exactly as they always
 * have. Only these forty-one names are spoken for.
 *
 * ## Read from the package, never from the caller
 *
 * Every asset is located from this module's own URL. `deno compile --include`
 * embeds `src/documents/` at the same relative path, the npm build copies the
 * tree into the emitted package, and JSR publishes the sources — so one lookup
 * is correct in a source checkout, a published package and a binary with no
 * checkout at all. A build that dropped an asset fails loudly at assembly rather
 * than resolving the name and finding nothing behind it.
 *
 * The read goes to the Effection filesystem directly rather than through
 * `API.Fs` or the document-facing `Files` provider. Both of those are
 * middleware a running document can compose around, and a review whose own
 * components could be answered by the document under review would have moved the
 * shadowing problem rather than solved it.
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
 * Every Markdown component this package declares, in the order it declares them.
 *
 * A written list rather than a directory walk. A compiled binary has no
 * directory to walk — `deno compile` embeds files, and enumerating them is not
 * something a build guarantees — so the manifest has to be data the module
 * carries. It also makes adding a component a reviewable edit rather than a
 * side effect of putting a file somewhere.
 *
 * The grouping is the same one the documents are filed under, and it travels
 * into the origin: a policy and a component are different kinds of thing to a
 * person reading a catalog, and the origin is where that shows.
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
 * How a packaged component identifies itself in a catalog.
 *
 * The package and the asset, never a filesystem path: the same component is at a
 * different absolute path in a checkout, a `node_modules` tree and a binary that
 * has no filesystem for it at all, and all three are the same component. This is
 * what lets a test compare a source run and a compiled run without knowing where
 * either one keeps its files.
 */
export function reviewDocumentOrigin(document: ReviewDocument): string {
  return `${REVIEW_ORIGIN}/${document.group}/${document.name}.md`;
}

/**
 * The thirty-five Markdown declarations, read from this build's own assets.
 *
 * Built fresh per assembly, exactly as `<Plan>`'s declaration is. A declaration
 * is not identified by object identity — what fixes it is the name, the origin,
 * the bytes and the digest — so two assemblies in one process declare the same
 * components without sharing a mutable array anyone could reach and edit.
 *
 * Lazy, and the reads happen here: this is trusted host assembly, before the
 * root document is imported. A missing asset, or bytes whose parse disagrees
 * with what is declared about them, fails here rather than at the moment a
 * review writes the name.
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
 * One review implementation, as a component the engine can call.
 *
 * Each of the six destructures the props it ships a schema for, and the engine
 * validates a record against that schema before it calls anything — so by the
 * time the implementation runs, the record is that shape. What TypeScript
 * cannot see is the correspondence between a JSON Schema *value* and a
 * TypeScript *type*, so a registration whose `fn` states its own prop type does
 * not structurally satisfy `FunctionComponent`.
 *
 * The narrowing is therefore stated once, here, instead of six implementations
 * being rewritten to take `Record<string, Json>` and parse themselves. They
 * moved out of `.reviews/components/` with their bodies unchanged, which is what
 * lets a reader diff the move and see only the import lines; changing every
 * signature to satisfy a boundary would have hidden that.
 *
 * It asserts nothing the schema does not already enforce. A component whose
 * declared type disagrees with its declared schema is a mistake in this package,
 * and the schema is what the engine holds a document to either way.
 */
// deno-lint-ignore no-explicit-any
function reviewComponent(fn: (props: any) => Operation<unknown>): FunctionComponent {
  return fn;
}

/**
 * The six TypeScript components, as reserved registrations.
 *
 * Reserved rather than ordinary, which is the registration tier's way of saying
 * what a Markdown declaration says: the host claims the name. Leaving these
 * ordinary would have moved thirty-five components out of the subject's reach
 * and left the six that run processes, read credentials and reach the network
 * shadowable — the half worth shadowing.
 *
 * They stay public and keep their existing names, props, returns and behavior.
 * Turning the two `CommentReview` helpers into private declarations was
 * considered and rejected: a declaration's privates may only be identity
 * factories, and making them private would change a contract the review roots
 * already depend on.
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
 * Install the six reserved registrations and the documentation describing them.
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
