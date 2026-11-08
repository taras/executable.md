
# Specifications

A specification describes the expected behavior of its surface completely
enough to reimplement it in another language from the spec and its linked
specs alone. Code is not authoritative: when code and a spec disagree, the
spec is the contract, and changing the contract is a decision, not an edit.

A spec passes if a competent engineer or fresh agent session unfamiliar with
the codebase can understand the behavior, reimplement it, and confirm that
conformance follows from the text - without reading the implementation.

## Changing a specification

- A behavior change ships as one pull request: mechanics, tests, and the
  spec together, described in the present tense. A behavior change without
  its spec change is incomplete.
- A contract change — anything that alters what an implementation must do —
  is a decision first: recorded with its trade-offs before the text moves.
- A spec-only edit (clarification, restructure, condensation) must preserve
  every normative statement. A fresh reviewer with no authorship context
  diffs the original against the revision, and the edit lands only when
  review converges: every cut accounted for, every addition labeled as new
  policy, and strengthened wording treated as drift equal to weakened
  wording.
- Verify spec-against-code drift deliberately, not incidentally. Found drift
  is either a code bug to fix or a decision to record — never a quiet spec
  edit.
- If a workaround cluster grows around a contract, file the missing
  primitive instead of building the cluster.
- Use only concepts and words this corpus defines. Introducing a new term
  requires asking the maintainer for permission first; define it where it
  belongs before using it, and align existing text retroactively.
- History and rationale live in decision records; a rationale stays in a
  spec only where the behavior's exact meaning depends on it. A
  point-in-time observation (a measurement, a byte count, a timing) belongs
  in a tool's output, never in a contract.

## Where behavior lives

- How the system is meant to work, shared invariants, resource lifetimes:
  architecture.md.
- Authored syntax, observable behavior, conformance: executable-mdx-spec.md.
  Feature specifications refine their own surfaces and interfaces.
- Workflow behavior: workflow-workspace-spec.md (single home). REPL behavior
  including composition: repl-spec.md (single home). Agent conversations:
  acp-client-spec.md; native handoff: native-agent-session-launch-spec.md.
- Each rule has exactly one home; other documents link to it. When two
  documents disagree, the owning home wins - fix the stale copy in the same
  change.
