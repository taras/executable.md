<Let
  as="broken"
  value={["# A plan that cannot be checked", "", "<NoSuchComponent />", ""].join("\n")}
/>

<Let
  as="fixed"
  value={[
    "# Approved program",
    "",
    "Write the evidence file this program names.",
    "",
    '<File path="planned.txt">the approved Plan ran</File>',
    "",
  ].join("\n")}
/>

<WhenPrompt template="{?anything}" />

{broken}

<WhenPrompt template="{?anything}" />

{broken}

<WhenPrompt template="{?anything}" />

{broken}

<WhenPrompt template="{?anything}" />

{broken}

<WhenPrompt template="{?anything}" />

{fixed}
