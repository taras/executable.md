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

<WhenPrompt template="{?before}Review the committed TODO changes{?after}" />

<Let as="acknowledged" select="code">
```xmd
<Output>TODO change acknowledged.</Output>
```
</Let>
{acknowledged}

<WhenPrompt template={"{?before}The person says:\n\nFinish the remaining TODOs."} />

<Let as="complete" select="code">
````xmd
<Sidekick.Todo as="items">
```diff
@@ -1,4 +1,4 @@
 - [x] Reproduce checkout
-- [ ] Fix checkout
-- [ ] Verify checkout
-- [ ] Review checkout
+- [x] Fix checkout
+- [x] Verify checkout
+- [x] Review checkout
```
</Sidekick.Todo>
````
</Let>
{complete}

<WhenPrompt template="{?receipt}Review checkout{?rest}" />

<Let as="completeResult" select="code">
```xmd
<Output>All TODOs complete.</Output>
```
</Let>
{completeResult}
