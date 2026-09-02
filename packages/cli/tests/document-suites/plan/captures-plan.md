# A document that captures its Plan and writes it down

The captured form emits nothing, so a reader of this run sees no program. What
it binds is written to a file, which is how a test compares the captured bytes
with the ones the bare form emits.

<Plan session="planner" as="approved">Write the release program.</Plan>

<File path="captured.txt">{approved}</File>

Captured the approved program.
