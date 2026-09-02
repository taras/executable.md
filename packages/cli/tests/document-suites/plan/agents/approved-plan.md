# The Plan this scenario writes

The coding agent behind a Plan is asked for one thing: a complete program, as
source and nothing else. This scenario answers that request with the same
program every time, so a test reading the approved source is reading a decision
this document made rather than a model's.

<WhenPrompt template="Create one complete XMD Plan{?rest}" />

The program is bound rather than written out, because writing it out would run
it: a `<File>` element in this document's body is an element this worker
expands. Interpolating the same text emits it as the characters it is, which is
what an agent replying with source actually sends.

<Let
  as="program"
  value={[
    "# Approved program",
    "",
    "Write the evidence file this program names.",
    "",
    '<File path="planned.txt">the approved Plan ran</File>',
    "",
  ].join("\n")}
/>

{program}
