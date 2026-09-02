<WhenPrompt template="{?lead}Create one complete XMD Plan from this Prompt:{?rest}" />

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
