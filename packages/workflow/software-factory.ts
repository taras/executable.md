/**
 * @module
 *
 * The GitHub Actions software factory's public identity rule.
 *
 * This subpath is deliberately not the package root. `@executablemd/workflow`
 * names no provider — that is what lets a second host implement the same
 * lifecycle — and the derivation here names GitHub in its scheme tag, its
 * authority rule and its node id, because the software factory is a GitHub
 * product by definition rather than one adapter of a neutral boundary.
 *
 * So the two surfaces are separate on purpose. Anything that needs the factory's
 * own contract asks for it by name:
 *
 * ```ts
 * import { deriveFactoryRunId } from "@executablemd/workflow/software-factory";
 *
 * const runId = yield* deriveFactoryRunId({
 *   authority: "github.com",
 *   issueNodeId: node,
 * });
 * ```
 *
 * One issue is one durable run, so this is the whole of "one issue, one run":
 * every host that admits the same issue arrives at the same 52 characters
 * without asking anybody. It is specified in
 * `specs/github-actions-software-factory-spec.md` §1.1 and restated in
 * `specs/workflow-spec.md` §9.1.
 *
 * Nothing here is runtime-specific. It uses the cross-runtime Web primitives —
 * `TextEncoder` and `crypto.subtle` — and names no host, so the provider host
 * and a GitHub intake reach the same single implementation rather than each
 * carrying a hash that has to agree byte for byte with the other's.
 */

export {
  admitFactoryRunSubject,
  admitIssueNodeId,
  base32Unpadded,
  canonicalGitHubAuthority,
  deriveFactoryRunId,
  FACTORY_RUN_ID_LENGTH,
  factoryRunIdPreimage,
  FactoryRunSubjectError,
} from "./src/software-factory/run-id.ts";
export type { FactoryRunSubject, FactoryRunSubjectFailure } from "./src/software-factory/run-id.ts";
