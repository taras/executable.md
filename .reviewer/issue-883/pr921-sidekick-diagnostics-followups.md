# Sidekick troubleshooting follow-ups

The Product Owner requested tickets for work outside the current Sidekick
correction after reviewing xmd-troubleshooting-recommendations.txt and the
rendered saved-file confirmation.

- [#932 — Inspect saved entry failures from the Sidekick](https://github.com/taras/executable.md/issues/932): read-only entry summaries, bounded saved agent-result inspection, discoverability and recovery guidance. REPL.EntryTrace remains a candidate name, not an accepted or existing API.
- [#933 — Make ACPX session saves reliable at prompt completion](https://github.com/taras/executable.md/issues/933): the independently observed Entry 22 temporary-file rename failure. Its cause is unresolved; timestamp-based temporary-file collision is explicitly a hypothesis. This ticket does not authorize changing the user's session files or rerunning the entry.
- [#931 — Sidekick conversation layout](https://github.com/taras/executable.md/issues/931) was extended with the file-link problem: concise readable labels, accessible exact targets, proper wrapping, and no automatic access/execution. Its existing conversation contract was preserved.

Duplicate searches found no open EntryTrace/entry-diagnostics issue or ACPX
ENOENT/session-save issue. #895, #898 and the existing REPL follow-ups remain
separate. #931 had no owner comments or implementation assignment identified
at this update.

The two new issues and the updated #931 body were independently fetched and
verified, including open state, exact description and labels. #932 carries
enhancement/UX, #933 carries bug, and #931 retains enhancement/UX.

These are follow-up stories, not additions to the active #921 presentation
correction. No production source, journal, agent session, branch, commit,
dependency state or CI state was changed. No agent prompt or entry was rerun.
