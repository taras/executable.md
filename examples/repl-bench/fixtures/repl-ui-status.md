<WhenPrompt template="{?context}Initialize this Sidekick for an ACP attachment.{?rest}" />

<Let as="ready" select="code">
```xmd
<Output>Status fixture ready.</Output>
```
</Let>
{ready}

<WhenPrompt template={"{?context}The person says:\n\nShow the formatting fixture."} />

<Let as="reply" select="code">
```xmd
<Output>


Reading cart.md.

    items.reduce((sum, item) => sum + item.price)
</Output>
```
</Let>
{reply}

<WhenPrompt template="unexpected prompt for the failure case" />
