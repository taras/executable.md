Long-form documentation for the components the `xmd` command registers.

One component, and it exists because a document usually has two audiences: the
person running it, who wants the result, and the person debugging it, who wants
to know how it got there.

## Verbose

Expands its content only when run verbosity is on.

```mdx
<Verbose>
Resolved {documents.length} documents from {include}.
</Verbose>
```

`--verbose` turns it on for the whole run, and a component may override
verbosity for its own content. When verbosity is off the content is not
expanded at all — so anything expensive inside it costs nothing on an ordinary
run, and this is a place to put detail rather than a place to hide it.

`as` captures the rendered verbose text, or an **empty string** when verbosity
is off. That is what lets a document build a diagnostic once and use it in more
than one place without branching on the flag itself.
