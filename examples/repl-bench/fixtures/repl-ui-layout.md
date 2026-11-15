<WhenPrompt template="{?context}Initialize this Sidekick for an ACP attachment.{?rest}" />

<Let as="ready" select="code">
```xmd
<Output>Layout fixture ready.</Output>
```
</Let>
{ready}

<WhenPrompt template={"{?context}The person says:\n\nPopulate the TODO list."} />

<Let as="todo" select="code">
````xmd
<Sidekick.Todo as="items">
```diff
@@ -0,0 +1,4 @@
+- [ ] Reproduce checkout
+- [ ] Fix checkout
+- [ ] Verify checkout
+- [ ] Review checkout
```
</Sidekick.Todo>
````
</Let>
{todo}

<WhenPrompt template="{?receipt}Reproduce checkout{?rest}" />

<Let as="done" select="code">
```xmd
<Output>Four TODOs saved.</Output>
```
</Let>
{done}
