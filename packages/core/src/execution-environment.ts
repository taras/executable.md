/**
 * The services and records one execution supplies while its document expands.
 *
 * An execution builds this bundle from what it captured and admitted, owns it
 * for as long as the run lasts, and passes it by value through canonical
 * expansion. It is private: no document, component or middleware can name it,
 * reach it, replace it, or add to it, which is why services that must not be
 * substitutable travel here rather than through a context — a context resolves
 * by name, and a name is not a secret.
 *
 * Members differ in what they are for. Some resolve or route what a name runs,
 * some carry records the execution keeps about its own output and identities,
 * and some describe the site being expanded. What they share is provenance, not
 * purpose: each was settled by the execution before the document could observe
 * it.
 *
 * Absence is meaningful and is not a degraded form of this object. An expansion
 * driven directly — a test, a tool describing a document — is handed no
 * environment at all, and that is what "nothing is installed here" looks like.
 * There is no partial environment.
 */

import type { Operation } from "effection";

import type { ImportAuthority } from "./components/component-resolution.ts";
import type { InstalledComponents, PrivateClosure } from "./components/declared-markdown.ts";
import type { ExecutionDeclarationCatalog } from "./execution-declarations.ts";
import type { EvaluationProfile } from "./evaluation-profile.ts";
import type {
  ComponentInvocation,
  ComponentRouting,
  FormSyntax,
  InvocationIdentities,
} from "./invocation-identity.ts";
import type { ExactSource } from "./output/exact-source.ts";
import type { SyntaxReference } from "./syntax-reference.ts";

/**
 * The services and records an execution supplies while its document is
 * expanded.
 *
 * @remarks
 * This interface is an architecture and product boundary. Do not add, remove,
 * rename, or reinterpret a member without explicit approval from both the
 * Architect and Product Owner.
 */
export interface ExecutionEnvironment {
  /**
   * Preserves the component selections this execution made after public import
   * middleware has run.
   *
   * For a name this execution fixed, it verifies the answer that came back and
   * returns the execution's own retained definition instead. An unrelated open
   * import keeps whatever the public chain answered.
   *
   * TODO(#811): Rename ImportAuthority to ComponentResolution — with closes() and
   * authorize() renamed for what they decide — and replace the remaining
   * authority terminology.
   */
  readonly componentResolution?: ImportAuthority;
  /**
   * Identifies structural syntax an installation provided, before a name is
   * looked up as an ordinary component import.
   *
   * Core builds one validated catalog before the document runs, and selection,
   * inspection, validation and execution all consume that same catalog, so the
   * four cannot describe a name differently. Even an execution that installs
   * nothing has one, which is why this member is required.
   */
  readonly declarations: ExecutionDeclarationCatalog;
  /**
   * Runs the Markdown components contributed through `ExecutionInstallation`.
   *
   * It identifies those components' private bodies and their current
   * source-output status. Absent when no Markdown component is installed.
   */
  readonly installedComponents?: InstalledComponents;
  /**
   * Identifies the helpers available only inside an installed component's own
   * Markdown body.
   *
   * @example
   * An installed `<Report>` is declared with a private `<Row>` helper. Inside
   * `Report.md`, `<Row />` resolves to that helper:
   *
   * ```md
   * <Row label="Total" />
   * ```
   *
   * Caller content projected into the body through `<Content />` does not
   * inherit the helper. The content was written by the caller, where `<Row>`
   * was never available, so it resolves there and not here.
   */
  readonly componentBodyScope?: PrivateClosure;
  /**
   * Lets an installed identity component obtain the stable identity of the XMD
   * element that invoked it.
   *
   * `<Session />` uses it to name the journaled work it starts, so the same
   * authored element names the same work on a later run. Component expansion
   * itself is not journaled; what is journaled is the work a component names
   * through this.
   */
  readonly componentIdentity?: InvocationIdentities;
  /**
   * Records which segments this execution produced as source rather than prose.
   *
   * Presentation currently reads the record to leave those segments
   * unformatted.
   *
   * TODO(#814): Carry this distinction in expansion output and remove this execution-private record.
   */
  readonly sourceSegments?: ExactSource;
  /**
   * Enables a component to behave differently self-closing than paired.
   *
   * @example
   * ```md
   * <File path="notes.md" />
   * <File path="notes.md">the new contents</File>
   * ```
   *
   * The first reads the file and the second writes it. The behavior stays tied
   * to the definition resolved for that name: this records which authored form
   * was selected, and does not decide what any name does.
   */
  readonly forms?: FormSyntax;
  /**
   * Describes the vocabulary available at the site being expanded.
   *
   * `<Syntax />` reports it. It is lexical, so a restricted evaluation boundary
   * narrows it for the subtree it admits and leaving that subtree restores the
   * enclosing vocabulary.
   *
   * Being described here is not permission to run: this says what a document
   * may write at this site, and every name it reports still resolves and is
   * admitted on its own terms.
   */
  readonly syntax?: SyntaxReference;
  /**
   * Supplies the components and operations generated XMD may use.
   *
   * @example
   * ```md
   * <Evaluate text={program} allow={["read"]} />
   * ```
   *
   * `allow` narrows what this profile already permits and never adds to it.
   * Absent means generated-XMD evaluation is unavailable — not unrestricted —
   * and `<Evaluate />` refuses.
   */
  readonly evaluationProfile?: EvaluationProfile;
  /**
   * Routes a selected definition to the implementation this execution retained.
   *
   * `<Syntax />` and `<Evaluate />` run core's own retained bodies rather than a
   * repository file, a registration, or anything import middleware substituted.
   * Generated XMD receives a narrower route than the document does, and every
   * route becomes unusable at teardown, so an implementation kept past the run
   * reaches a table that is gone.
   */
  readonly componentRouting?: ComponentRouting;
  /**
   * Verifies a generated-XMD component and the authored form preflight
   * accepted, then runs its body.
   *
   * @example
   * A fragment admitted for reading may write `<File path="notes.md" />`. The
   * paired write form is not admitted, so
   * `<File path="notes.md">…</File>` is refused here rather than run.
   */
  readonly invokeGeneratedComponent?: (
    fn: unknown,
    invocation: ComponentInvocation,
    body: Operation<unknown>,
  ) => Operation<unknown>;
}
