# Replacement PR1 — REQUEST CHANGES

Reviewed fdcef4281ac15b059d3db1a4594ffb8972bcd269, parent/target
986948eabd070c0ae7354c2a0db8df7feed63621. Signature G / tarasm@gmail.com,
agent/issue-883-pr1-main-integration, clean. PR2 remains clean at accepted C,
d4b0e326d76fa63c6ee7a97e189986bbd371243d.

The five frozen commands pass after allowing command 5's required loopback
listener. Two focused live probes expose contract violations not covered by
those commands. The public exports and two integration evidence requirements
also need correction. Do not start replacement PR2 yet.

Authority: [Architect decision](pr890-pr921-main-integration-architect-decision.md),
[combined plan](pr890-pr921-main-integration-planner-handoff.md), IN1–IN4/IN7,
and [release](pr890-pr921-main-integration-planner-release-d4b0e326.md).
These findings restore those existing criteria; they introduce no new product
choice or public capability.

## IP1 — selecting canonical Syntax makes roots refuse

evaluateRoot() unconditionally appends pinnedComponent(SYNTAX_COMPONENT,
binding.definition) to selected.observations. execute.ts also unconditionally
appends Syntax to the describing entries. Main's capture has already retained
the selected canonical Syntax implementation through its own routed guard, so
an execution selecting `{ Syntax: ["self-closing"] }` reaches two definitions
under that name.

The real held-host probe returns:

```text
canonical Syntax selected: ok false
a generated-XMD allowlist admitted one name with two definitions.
control, File selected: ok true
```

[Probe](pr890-captured-syntax-probe-fdcef428.test.ts),
[runtime first output after correcting probe typing](pr890-captured-syntax-probe-fdcef428-corrected-fixture.log).
The [initial output](pr890-captured-syntax-probe-fdcef428-first.log) is a
reviewer fixture type-inference error, not a product failure or flake.

The decision explicitly requires one entry when the captured selection already
contains canonical Syntax, including its own captured/routed guard. Removing
Syntax from every test selection avoids the supported path rather than proving
it. Main's ordinary selection includes Syntax, so this is a concrete consumer.

Recognize and retain the owning execution's exact canonical selection once in
both admission and description. Do not accept an arbitrary same-name/URL
replacement as canonical, drop the collision check, or create a profile when
none was captured. Preserve the different-implementation collision. Promote
the live regression and control; assert one Syntax row in the recorded policy
and descriptive vocabulary, with ordinary Syntax evaluation/capture working.

## IP2 — availability refusals fail the owning document

Two errors leave before the ordinary request-result boundary:

- execute.ts's absent-profile bound operation throws HostExecutionError.
- evaluateRoot() calls binding.select(selection(request.allow)) before try;
  an unavailable effect class therefore throws ComponentInvocationError outside
  its ordinary refusal handling.

The generated-root owner treats those raised errors as authoritative evaluation
failures. A host catches the method's refusal, releases its ordinary held
document, and still receives failed canonical completion.

The focused real-host probe establishes both cases and an available-read
control:

```text
no selection:          refused true, completion false
unavailable write:     refused true, completion false
available read:        refused false, completion true
```

[Probe](pr890-root-refusal-probe-fdcef428.test.ts),
[complete first output](pr890-root-refusal-probe-fdcef428-first.log).

The bound contract distinguishes availability/ordinary request refusals from
fatal failures of the owner. Return these expected refusals through the existing
Result/classification boundary without recording a fatal owner failure. Preserve
the existing diagnostics and no generated component/effect work. Do not move
absence refusal back to execution startup, suppress all raised failures, or
weaken canonical durability, Files, secret-policy and teardown authority.
Promote the two arms/control and retain E7/CV31/CV32.

## IP3 — the settled public request exports are missing

The decision names GeneratedXmdRequest as the four-member public root request
and explicitly keeps GeneratedEffectClass at core/host. host.ts instead exports
GeneratedXmdRootRequest, and exports neither accepted name.

Expose GeneratedXmdRequest and GeneratedEffectClass from the trusted host
entrypoint, with both bound methods accepting the decided id/source/allow?/
position? shape. Do not expose the internal table-taking fragment request under
that name. Internal type names are delegated; no broad rename or compatibility
API is required. Remove the unapproved alternative public request name rather
than keeping two public names by default. Add an ordinary typed consumer through
core/host so the focused corpus checks the accepted boundary.

## IP4 — two new form-list casts bypass the repository rule

The newly adapted formsOf() helpers in generated-xmd-root.test.ts and
agent-conversation.test.ts use filter(...) as ("self-closing" | "paired")[].
These are new in the adaptation relative to accepted C. Use a typed list of the
known forms and ordinary filtering, or the existing canonical typed validator.
Do not introduce a replacement assertion or parser. This does not authorize
rewriting older deliberate malformed fixtures or unrelated tests.

## IE1 — record compatibility evidence does not cover IN1/IN4

The reported fragment-to-root replay gap remains. GR11 establishes what writers
emit, not what a reader refuses. GR15c is also not a sufficient reverse witness:
it offers `<Output>...` to a fragment, which is already illegal fragment
language, and asserts only that some failure occurred. It can pass on a fresh
language refusal or a history mismatch without establishing the expected-marker
check. GR13 tests sequence partition rather than cross-kind authorization.

Use source legal in both kinds and equal selected rows when offering a
foreign-marker admission. Establish the unreadable admission classification and
zero invoked effects in both directions, not merely any error. A held host with
an already completed main document cannot supply its readiness latch; do not
reinstate that unsettled fixture. The Core-private bound evaluator and genuine
durable admission seam can be exercised with the existing minted identity/route
fixtures; the public owner separately proves sequence allocation. No public
test hook or alternate table-taking host method is needed. Preserve main's
unknown/mixed/extra-member refusal and existing marker-4 continuation.

IN4 additionally names earlier marker-2 root sequences. E4/E6/GR12–GR14 create
and reopen this integrated build's marker-5 roots; they do not supply the older
shape. Add a small old-root journal case from the accepted pre-integration
writer/fixture: opening repeats neither completed effect nor interrupted suffix,
and a new explicit root allocates past those sequences and writes marker 5.
Keep the main/completed-document replay bypass. Do not rewrite user history or
mislabel a fresh marker-5 fixture as old-format evidence.

These are the compatibility observations frozen in IN1/IN4, not a new migration
matrix or requirement to resume an old root's suffix. Keep private mechanics
delegated and reuse existing host/conversation fixtures.

## Independent verification

| Frozen command | Result | Preserved output |
| --- | --- | --- |
| 1 | exit 0; 28 tests / 129 steps | [first log](pr890-replacement-review-fdcef428-command-1-first.log) |
| 2 | exit 0; 34 / 266 | [first log](pr890-replacement-review-fdcef428-command-2-first.log) |
| 3 | exit 0; 14 / 143 | [first log](pr890-replacement-review-fdcef428-command-3-first.log) |
| 4 | exit 0; 24 / 160 | [first log](pr890-replacement-review-fdcef428-command-4-first.log) |
| 5, network sandbox | exit 1; 7 / 31 passed, WGX13/WGX15 cannot listen on 127.0.0.1 (EACCES) | [first log](pr890-replacement-review-fdcef428-command-5-first.log) |
| 5, approved loopback access | exit 0; 8 / 33 | [retry log](pr890-replacement-review-fdcef428-command-5-loopback.log) |

The five commands total 108 tests / 731 steps passing with the required runtime
access. The first command-5 failure is an observed environment restriction;
source, dependencies, cache, tests and listener expectations were not changed
to make it pass. No identical-environment flake claim is made.

The independent Syntax probe has one regression failure/one passing control;
the availability probe has two regression failures/one passing control. Their
complete outputs remain above. Check is Implementor-reported and was not rerun;
no broad lint, JSR, runtime suite or CI was inspected. Both implementation
worktrees remain clean and their branches were not moved by review.

## Next action

Execute [the correction prompt](pr890-replacement-correction-prompt-fdcef428.md)
and return one signed successor of fdcef428, preserving that commit and both
original PR refs. Rerun the five frozen PR1 commands and the two corrected
runtime probes; promote the regressions and complete IN1/IN4 in the discovered
corpus. No unrelated mutation battery is assigned.

PR2 remains at C until a recorded PASS on replacement PR1's successor. Its
separate UI amendment, EH1/UI10, B–D, #922, teaching, captures and publication
stay outside this correction. The Architect decision is settled; none of these
findings calls for a new interface interview.
