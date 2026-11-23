<WhenPrompt template="{?context}Initialize this Sidekick for an ACP attachment.{?rest}" />

<Let as="ready" select="code">
```xmd
<Output>Scripted Sidekick ready.</Output>
```
</Let>
{ready}

<WhenPrompt>
{?context}The person says:

Show the Markdown fixture.
</WhenPrompt>

<Let as="submission" select="code">
  ``````xmd
  <Output>
  # Sidekick fixture heading

  **sidekick strong** plain
  *sidekick slant* plain
  `sidekick code` plain
  [sidekick fixture label](https://example.test/sidekick-target) plain

  - sidekick first item
  - sidekick second item
  - [ ] sidekick task item

  ```text
    sidekick fence indent

  # sidekick fence *literal*
  ```
  Sidekick fixture end.
  </Output>
  <Let as="entry" select="code">
  `````xmd
  # Entry fixture heading

  **entry strong** plain
  *entry slant* plain
  `entry code` plain
  [entry fixture label](https://example.test/entry-target) plain
  Entry prose keeps going long enough to wrap inside the wide centre pane, so its **entry wrapped strong** run lands after a measured break.

  1. entry first step
  2. entry second step
  3. [x] entry task step

  ```text
    entry fence indent

  # entry fence *literal*
  ```
  Entry fixture end.
  `````
  </Let>
  <REPL.EntryInput>{entry}</REPL.EntryInput>
  <REPL.Submit />
  ``````
</Let>
{submission}

<WhenPrompt template="{?receipt}Entry entry-1 completed.{?rest}" />

<Let as="done" select="code">
```xmd
<Output>Markdown fixture receipt read.</Output>
```
</Let>
{done}
