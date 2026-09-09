<WhenPrompt template="{?lead}Create one complete XMD Plan from this Prompt:{?rest}" />

<Let
  as="prohibited"
  value={['<File path="notes.md">written</File>', ""].join("\n")}
/>

{prohibited}

<WhenPrompt template="{?lead}That request was refused{?rest}" />

<Let
  as="request"
  value={[
    '<Syntax names={["File"]} as="documented" />',
    "<Json value={documented} />",
    "",
  ].join("\n")}
/>

{request}

<WhenPrompt template="{?lead}**Available in this evaluation:** yes{?rest}" />

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
