<WhenPrompt template="{?before}Write an executable Markdown document that does this:{?rest}" />

<Let
  as="source"
  value={'# Ask for a name\n\n<Elicit schema={{ type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false }} as="answer">\nWhat is your name?\n</Elicit>\n\n<File path="name.txt">{answer.name}</File>\n'}
/>
{source}
