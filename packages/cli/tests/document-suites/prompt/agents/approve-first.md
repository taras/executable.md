<WhenPrompt template="{?before}Write an executable Markdown document that does this:{?rest}" />

<Let
  as="source"
  value={'# Ask for a name\n\n<Output>\nEVALUATED name.txt\n</Output>\n'}
/>
{source}
