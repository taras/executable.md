# Structural indentation is not content

Date: 2026-11-23

Approved through issue [#1025](https://github.com/taras/executable.md/issues/1025)
and its [formatter examples](../formatter-examples.md).

## Context

Every source byte between an element's tags was content. Indenting a nested
`<If>` inside `<File>` wrote the indentation into the file, and the newlines
around a block's tags were the file's first and last bytes, so readable nesting
changed what a document produced. A formatter could not indent XMD without
changing its behavior, and generated XMD arrived flat because indentation was
never safe.

## Decision

Structural indentation is part of ordinary XMD syntax. A block's body loses two
spaces per enclosing block at the start of each line that has them; a line with
fewer keeps all of its spaces. A standalone element's line is a delimiter line:
its indentation is not content, and it supplies its newline only to a nonempty
rendering that lacks one. After the prefix, a line indented four columns past a
blank line is Markdown indented code. The [language
specification](../executable-mdx-spec.md#structural-indentation-and-standalone-lines)
owns the rule.

The scanner applies the rule in the same walk that recognizes elements and
fences, so execution and formatting read one grammar.

## Trade-offs

- A document written before the rule changes meaning where a block's body was
  not indented but held lines that carry the prefix — typically a fence at
  column zero inside `<Let>` or `<Test>` whose contents are indented YAML, JSON
  or TypeScript. Those lines now lose the prefix. The repository's documents of
  that shape were re-indented in the same change, verified by comparing the
  elements, executable blocks and passive fence bytes each document produced
  before and after.
- A body indented less than its depth keeps its spaces, so a deep under-indented
  tag after a blank line can become indented code. Formatting adds the full
  prefix and removes the ambiguity.
- Indented-code recognition follows blank lines within one body and does not
  model Markdown list containers: four columns past the prefix after a blank
  line is code even where a list item's continuation would make it a paragraph.
- Output that relied on the newline around a standalone element — a blank line
  after a capture, a leading newline in a written file — now has one fewer
  newline.
