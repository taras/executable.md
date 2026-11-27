## Sidekick.Todo

Read the checklist you share with the person:

```xmd
<Sidekick.Todo />
```

In a Sidekick response, the read gives you Markdown checklist feedback or
“The checklist is empty.” Use an explicit `Output` to share content with the
person. In a REPL entry, the bare read renders the checklist in the entry.
Use `<Sidekick.Todo as="items" />` to bind ordered items with `text` and
`completed` fields.

To edit it, keep the `as` binding, read first and supply a unified diff matching that source:

````xmd
<Sidekick.Todo as="items">
```diff
@@ -1 +1 @@
-- [ ] Review the proposal
+- [x] Review the proposal
```
</Sidekick.Todo>
````

The checklist belongs to this session even inside a different `Dir` or entry.
A stale patch refuses without changing any task. Keep inline Markdown source
in task text; nested tasks and images refuse with the affected line.

A bound read or successful edit in a Sidekick response sends its structured
result through ordinary control feedback. A person's idle edit can start a TODO
change message. Busy edits wait as context for the next independently allowed
prompt; they do not interrupt work or resume a stopped exchange.
