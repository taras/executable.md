# Architect return: retained configuration can be waived by session routing

Review exact signed commit `ef68c71ca26d24856e6a4a1e9d24943bd37876d1`,
parent `a66c5d8a5391d43cf8328435bba622a79cc7076b`, on agent/issue-883-pr2.
Implementation worktree: .claude/worktrees/issue-883-pr2. The worktree is clean.
No production change, index change, push or CI inspection was made by this review.

A retained conversation can now take a native turn without saving or comparing
its required configuration. An ordinary Agent.session middleware handler
forwards the opaque request's name to next. The provider reads that as an ordinary
named-session request and never receives the setup activation requirement.
Core accepts the returned Session and sends the prompt.

## Settled invariant and concrete evidence

The accepted [configuration decision](pr2-recovery-creation-policy-architect-decision.md)
requires Core to save configuration before native creation and compare it before
reattachment. It states:

> Core's configuration check cannot be supplied or waived by a replaceable contextual value or CLI prose.

The [configuration handoff](pr2-session-configuration-planner-handoff.md) SC3
requires a retained setup with no full configuration to refuse before native
work, while keeping ordinary sessions usable outside this requirement.

This is a supported host installation using the existing public Agent middleware
API, with the real Core conversation and actual ACP provider. It creates no
fake journal, copied mapping algorithm, forged native identity or hostile object.

This routing is expressly supported by specs/acp-client-spec.md's ordinary
Session configuration contract: replacing the request with a raw string selects
the unconfigured path. That existing model/effort routing behavior must be
reconciled with the separately accepted, mandatory conversation configuration
check. It cannot silently become an opt-out from that check.

The relevant routing handler is:

```ts
yield* Agent.around({
  *session([request], next) {
    return yield* next(
      typeof request === "object" && request !== null && "with" in request
        ? request.name
        : request,
    );
  },
}, { at: "max" });
```

The provider's tool/server inputs are deliberately unspecified, the same
missing-configuration case the accepted SC3 refusal already covers.
The unchanged-request control refuses with the expected "did not state"
configuration reason and zero ensures. Adding only the routing handler gives:

```json
{"answered":true,"ensures":1,"turns":["first"],"configurationRecords":0}
```

The turn succeeded, native session work occurred and no configuration was saved.
That directly violates creation-before-configuration ordering. The same missing
activation also leaves later compatible/incompatible checks unreachable on this
route; matching identities do not substitute for them.

## Reproducers

Both probes reuse the existing production test fixtures outside the runtime
test corpus. Relative imports point at the implementation worktree. The ACP
probe uses the actual createAcpxProvider with only its transport scripted.

- [Core probe](pr2-configuration-request-routing-ef68c71c.probe.ts)
- [ACP probe](pr2-configuration-acp-request-routing-ef68c71c.probe.ts)
- [Core first output](pr2-configuration-review-ef68c71c-routing-first.log)
- [ACP first output](pr2-configuration-review-ef68c71c-acp-routing-first.log)
- [Core checked verification](pr2-configuration-review-ef68c71c-routing-verified.log)
- [ACP checked verification](pr2-configuration-review-ef68c71c-acp-routing-verified.log)

The verification runs use the implementation worktree's explicit deno.json,
enable type checking, and assert the control's specific configuration refusal.
Each has one green control and one failing routing regression.

Run from the implementation worktree, substituting the repository root for ROOT:

```text
deno test --config ./deno.json --allow-all --filter 'configuration request routing probe' ROOT/.reviewer/issue-883/pr2-configuration-request-routing-ef68c71c.probe.ts
deno test --config ./deno.json --allow-all --filter 'ACP configuration request routing probe' ROOT/.reviewer/issue-883/pr2-configuration-acp-request-routing-ef68c71c.probe.ts
```

## Direct trace

1. conversationTurn() binds admitting(active) inside openSessionRequest and sends
   the request through Agent.operations.session.
2. The public middleware changes that routed argument to its descriptive name.
3. ACP resolveSession() obtains a setup only for a session-request-shaped object.
   A string selects its ordinary named-session path.
4. setup is absent, so the new activate call is skipped.
5. Core closes the original issuance when session resolution returns, but checks
   no successful activation for that owned resolution before sending the prompt.

The disclosure is about where the requirement is enforced, not whether
sameJson detects differences. The frozen SC2 comparison control remains useful
on the normal route but cannot detect an activation that never happened.

## Required Architect disposition

Identify the smallest Core-owned enforcement point that keeps this requirement
effective through supported routing and refuses an unactivated conversation
resolution BEFORE any provider creation, reattachment/ensure or new turn.
Checking only the Session returned to conversationTurn is too late for a
provider that already reattached during resolution.

Preserve legitimate descriptive-name derivation, ordinary raw/named Session
use outside retained conversation work, options inspection, the accepted
activate/finish distinction, native assertions, one-attempt lifetime and
cancellation joining. Do not turn all ordinary provider calls into retained
conversation calls or add a public scope flag.

First determine whether an existing private canonical mechanism can enforce
the accepted invariant. Return its exact before-effects trace and the bounded
correction. If a new interface, authority channel or ownership boundary is
necessary, interview the Product Owner before declaring the design complete.
Do not rely on replaceable Context state, a CLI promise to always forward the
request, or a provider silently choosing to treat the work as ordinary.

This restores the already settled invariant. It is not a request for another
policy/crash permutation matrix. Keep the one unchanged-request refusal
control and the one name-forwarding regression through the real ACP path.
The Planner will assign their permanent destinations after the ruling.

The three assigned commands independently pass 42 tests/261 steps. A separate
Rule 13 Result-union correction remains for the Implementor and needs no
architecture decision. Parser reuse, detach-once snapshots and explicit unknown
configuration refusal remain acceptable implementation choices.

Return the decision and Planner handoff under
.reviewer/issue-883/pr2-configuration-request-routing-architect-decision.md.
R2 remains incomplete. No new production implementation, public interface,
mounted section 5 work, push, GitHub mutation or CI inspection is authorized
by this Architect review request.
