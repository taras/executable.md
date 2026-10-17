# Implementor correction: refuse unresolved feedback acceptance

Continue from signed `87b25a40915a697a580e619072d433c9c676fec0` on
agent/issue-883-pr2. Preserve the persistent-store interruption, production
missing-marker recognition and recovered-work report; those corrections pass.
The Planner review is pr2-recovery-planner-review-87b25a40.md.

The message ID/recorded turn number question is now resolved by
pr2-recovery-message-correlation-architect-decision.md. Implement its private
read and bookkeeping changes under
pr2-recovery-message-correlation-planner-handoff.md alongside this refusal.
That handoff freezes the existing R2m2 evidence extension and uses the same
focused command selection. Creation-policy compatibility remains separate.

Finish the unresolved-acceptance refusal already assigned in the previous
correction. R2q unknown currently proves that the provider accepted feedback
turn 2 and its acknowledgement in Core's saved records never landed. The detached reading
correctly reports feedback text whose delivery is unresolved, but the next
message still starts a provider turn and writes its ordinary records. storage-contract.md requires
reconciliation with saved turn facts or refusal of this unknown accepted-turn status.

Before explicit work continues the active conversation, use the production
reading to refuse when that delivery remains unestablished. Answer with an
ordinary refusal explaining that acceptance cannot be established. Do so before
provider session placement, message/reference writes or another prompt. Keep
the feedback delivery unresolved and both paired files unchanged by the refusal.
A carrying turn whose completion Core's saved records establish must still allow
new work even when its
local delivery marker is absent. Cold reopening remains read-only.

Do not resend the old feedback, guess a turn, fabricate a marker/outcome, choose
a replacement conversation or introduce a second recovery owner. Do not change
the accepted first-turn assertion interruption, Stop, Elicit or entry admission
behavior. The creation-policy representation remains an Architect question.
The message ID/recorded turn number distinction follows the accepted decision and
companion Planner handoff; do not invent a different boundary.

Replace R2q unknown's assertion that the later message succeeds with the actual
refusal contract. Integrate the new independent probe's observations into that
row and keep its completed/missing-marker control. Prove the refusal through
actual provider traffic and unchanged paired bytes, not only the returned Err.
Restore the missing guard once: the unknown arm must fail while the established
control remains green. Verify the mutation applied before interpreting it.

Run these finite commands from the implementation worktree:

```text
deno test --config deno.json --allow-all /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-recovery-unknown-probe-87b25a40.test.ts
deno test --config deno.json --allow-all /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-recovery-contract-probe-14ee0d8e.test.ts
deno task test packages/cli/tests/repl-sidekick-configuration.test.ts packages/cli/tests/repl-sidekick-journey.test.ts packages/cli/tests/repl-sidekick-lifecycle.test.ts packages/cli/tests/repl-sidekick-controls.test.ts packages/cli/tests/repl-sidekick-recovery.test.ts packages/cli/tests/repl-sidekick-storage.test.ts packages/cli/tests/repl-history.test.ts
```

Also rerun the six unchanged metadata/startup/join/receipt/contract/owner probe
commands frozen in pr2-configuration-agent-implementor-prompt.md. If session.ts
changes, rerun the previously frozen consumers command covering Sidekick output,
entries, route, lifecycle and agent-journey. This refusal needs no agent/provider
interface change; do not repeat the broader adapter/workflow selections solely
for confidence. No full suite, check, lint or CI prerequisite is added.

Align only the affected specification/architecture sentences with the existing
refusal contract. Commit promptly when the focused evidence passes. Return the
exact signed SHA, parent, branch, tree status, every focused command/result and
the refusal/control observations. Stop for review. R2 closure still needs the
creation-policy ruling and its finite implementation evidence. No section 5,
push, GitHub write or CI inspection is authorized by this correction.
