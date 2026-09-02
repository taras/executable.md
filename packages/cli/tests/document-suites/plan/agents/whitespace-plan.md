<WhenPrompt template="{?lead}Create one complete XMD Plan from this Prompt:{?rest}" />

<Let
  as="program"
  value={[
    "# Approved program",
    "",
    "This program writes a file when something runs it.   ",
    "",
    "",
    "",
    '<File path="planned.txt">the approved Plan ran</File>',
    "",
  ].join("\n")}
/>

{program}
