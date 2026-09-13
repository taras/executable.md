/**
 * What core's own expansion runs in (spec §5.3).
 *
 * An execution builds one of these from what it admitted, holds it by value,
 * and passes it into core's own expansion. Everything on it decides what a
 * document may invoke and what it may name, and a decision like that never
 * reads replaceable state — so no document, component or middleware can reach
 * this object, replace it, or add to it.
 *
 * It lives in its own module rather than beside the import table because what
 * an execution imports through is one member of it. The import-specific
 * machinery stays where it was.
 */

import type { Operation } from "effection";

import type { ImportAuthority } from "./components/import-authority.ts";
import type { DeclaredImports, PrivateClosure } from "./components/declared-markdown.ts";
import type { ExecutionDeclarationCatalog } from "./execution-declarations.ts";
import type { CapturedProfile } from "./evaluation-profile.ts";
import type {
  ComponentInvocation,
  FormSelections,
  InvocationIdentities,
  ProtectedBodies,
} from "./invocation-identity.ts";
import type { ExactSource } from "./output/exact-source.ts";
import type { SyntaxReference } from "./syntax-reference.ts";

/**
 * What core's own expansion is given, beside the segments.
 *
 * Absence is meaningful and is not a degraded form of this object: an expansion
 * driven directly — a test, a tool describing a document — is handed no
 * environment at all, and that is what "no installed structural syntax is
 * available here" looks like. There is no partial environment.
 */
export interface ExecutionEnvironment {
  /** What a closed execution may invoke for a name. Absent for an open one. */
  readonly imports?: ImportAuthority;
  /**
   * Everything this execution declares, as expansion reads it.
   *
   * Required, unlike the members beside it: an execution always admits a
   * catalog, even one holding nothing, so expansion asks it about every name
   * rather than deciding whether asking is possible.
   *
   * It carries the handler each installation supplied with its declarations.
   * That is why it is on this object rather than in a context: a context
   * resolves by name, and a name is not a secret, so a document could build one
   * and answer for what expands its own syntax.
   */
  readonly declarations: ExecutionDeclarationCatalog;
  /**
   * The exact Markdown this execution declares, and the register one private
   * import is offered through.
   *
   * Held by the execution and handed here by value, like everything else on
   * this object: an expansion reaching it is core's own, and nothing a
   * document, a component or middleware can name reaches it.
   */
  readonly declared?: DeclaredImports;
  /**
   * The private names the segments being expanded may write, when they are a
   * declaration's own body.
   *
   * This is the one member that changes as expansion descends. A declared
   * component's body carries its closure; everything else — the caller, the
   * content the caller projected, an imported component, a sibling invocation —
   * carries whatever it carried, which for an ordinary document is nothing.
   */
  readonly privates?: PrivateClosure;
  /** The domains this execution minted, for the components it gave one. */
  readonly identities?: InvocationIdentities;
  /**
   * Which segments this execution produced as a program's source.
   *
   * Held by the execution and handed here by value, like everything else on
   * this object. It is on the private environment rather than in a context
   * because a context resolves by name, and a name is not a secret: a component
   * could build one, reach the record and answer that everything is exact.
   */
  readonly exact?: ExactSource;
  /**
   * What canonical resolution selected for each import, for the components
   * whose authored form selects an effect.
   *
   * Held by the execution and handed here by value, like the identities beside
   * it: an expansion reaching this object is core's own, and nothing a document,
   * a component or middleware can name reaches it.
   */
  readonly forms?: FormSelections;
  /**
   * What a document may write at the site being expanded.
   *
   * The execution builds one at its root from the selection inputs it captured,
   * and hands it here by value like everything else on this object — not through
   * a Context, because a context resolves by name and a name is not a secret, so
   * a document could build one and answer for the vocabulary it is shown.
   *
   * It is lexical. A trusted canonical evaluation boundary that has already
   * admitted the exact vocabulary a subtree may write replaces this member for
   * that subtree, and leaving the subtree restores the enclosing one. Nothing
   * else changes it: an ordinary component's body, the content a caller
   * projected and an imported definition each carry what the site carried.
   */
  readonly syntax?: SyntaxReference;
  /**
   * The maximum authority a generated fragment may be evaluated under.
   *
   * Stated by the trusted host at the installation boundary, before the root
   * import and before any document, component or middleware code exists, and
   * handed here by value like everything else on this object. It is on the
   * private environment rather than in a context for the reason the rest are,
   * and one more: `<Evaluate>` is a *public* component, so any author may write
   * it, and what keeps that from being a capability is that the ceiling it
   * narrows from was settled by somebody the document cannot reach.
   *
   * Absent for a host that offers no evaluation. That is not an unrestricted
   * evaluation — it is no evaluation, and `<Evaluate>` refuses.
   */
  readonly evaluation?: CapturedProfile;
  /**
   * The bodies this execution will enter for the components canonical core
   * protects.
   *
   * Held by the execution and handed here by value, like the identity domains
   * beside it. It is what makes a protected implementation reachable at all: an
   * implementation another loaded copy built is in that copy's table, and one
   * kept past this execution's teardown reaches a table that is gone.
   */
  readonly protectedBodies?: ProtectedBodies;
  /** The generated import's form check and result collection, around either body kind. */
  readonly invoke?: (
    fn: unknown,
    invocation: ComponentInvocation,
    body: Operation<unknown>,
  ) => Operation<unknown>;
}
