# XMD formatter examples

These examples illustrate the [formatter contract](formatter-spec.md). Structural
indentation is part of ordinary XMD syntax. The formatter uses two spaces per
level. In the expected strings below, `\n` denotes a newline.

## Indent the whole body

```xmd
<File path="message.txt">
  <If condition={true}>
    Hello

      Keep two leading spaces.
  </If>
</File>
```

The file contains `"Hello\n\n  Keep two leading spaces.\n"`. Two enclosing blocks
account for four leading spaces. The extra two spaces and the blank line are
content. The standalone opening and closing block delimiters contribute no
lines.

## Preserve mixed indentation when formatting

Before formatting:

```xmd
<File path="message.txt">
  <If condition={true}>
    Four source spaces.
  Two source spaces.
No source spaces.
  </If>
</File>
```

After formatting:

```xmd
<File path="message.txt">
  <If condition={true}>
    Four source spaces.
      Two source spaces.
    No source spaces.
  </If>
</File>
```

Both write `"Four source spaces.\n  Two source spaces.\nNo source spaces.\n"`.
At this depth, a line with fewer than four leading spaces has no structural
prefix to remove. The formatter adds the full prefix and keeps the content
spaces. A second formatting pass makes no changes.

## Keep inline tags inline

```xmd
<File path="status.txt">
  Status: <If condition={true}>ready</If> now.
</File>
```

The file contains `"Status: ready now.\n"`. The inline tag contributes no
indentation level. The spaces around `ready` remain.

## Keep standalone text on its own line

```xmd
<Output>
  Before
  <File path="name.txt" />
  After
</Output>
```

| Contents of `name.txt` | Result |
| --- | --- |
| `""` | `"Before\nAfter\n"` |
| `"Ada"` | `"Before\nAda\nAfter\n"` |
| `"Ada\n"` | `"Before\nAda\nAfter\n"` |
| `"Ada\n\n"` | `"Before\nAda\n\nAfter\n"` |

A standalone invocation supplies its source newline when it returns text that
needs a line ending. An empty result contributes no line. Newlines already
present in the returned text stay intact.

## Split tag attributes across lines

```xmd
<Output>
  <If
    condition={true}
  >
    Hello
  </If>
</Output>
```

The result is `"Hello\n"`. The opening tag consumes three source lines as one
delimiter. The attribute indentation contributes nothing to the body.

## Preserve Markdown indentation

```xmd
<Output>
  - First item
    - Nested item
  - Last item
</Output>
```

Markdown receives:

```md
- First item
  - Nested item
- Last item
```

The same rule applies when a list item contains an XMD block:

```xmd
<Output>
  - Status
    <If condition={true}>
      Ready
    </If>
  - Next
</Output>
```

Markdown receives:

```md
- Status
  Ready
- Next
```

Four of the six spaces before `Ready` come from the two XMD blocks. The
remaining two keep the line inside the `Status` list item.

## Move a fence with its enclosing block

````xmd
<If condition={true}>
  ```bash exec
  cat <<'TEXT'
    Keep two leading spaces.
  TEXT
  ```
</If>
````

The shell receives:

```bash
cat <<'TEXT'
  Keep two leading spaces.
TEXT
```

The fence moves with its enclosing XMD block. The heredoc keeps its content
indentation and its closing delimiter stays at column one.

## Distinguish nested tags from indented Markdown code

```xmd
<Output>
  <If condition={true}>
    <If condition={true}>
      Ready
    </If>
  </If>

      <If condition={true}>Show this as code.</If>
</Output>
```

Markdown receives:

```md
Ready

    <If condition={true}>Show this as code.</If>
```

The inner executable tag starts four spaces into the source. Those four
spaces come from its enclosing XMD blocks. The last tag starts six spaces
into the source, and four remain after removing the `<Output>` prefix.
Markdown treats that line as literal code.

## Preserve content tabs

Inside a `<File>` body, the structural prefix is two spaces. Here `\t` denotes
a literal tab.

| Source line | Bytes written |
| --- | --- |
| `"  \tIndented with a tab\n"` | `"\tIndented with a tab\n"` |
| `"\tIndented with a tab\n"` | `"\tIndented with a tab\n"` |

Both lines format to `"  \tIndented with a tab\n"`. The XMD prefix uses spaces.
Any remaining tab goes to the consumer unchanged.

## Preserve intentional spaces on blank lines

Inside a `<File>` body:

| Source line | Bytes written | Formatted source line |
| --- | --- | --- |
| `"\n"` | `"\n"` | `"\n"` |
| `"  \n"` | `"\n"` | `"\n"` |
| `"    \n"` | `"  \n"` | `"    \n"` |

A blank line stays blank. Spaces beyond the structural prefix stay in the
file even when the line contains no visible text.

## Preserve a missing final source newline

The source ends immediately after this standalone invocation:

```xmd
<File path="name.txt" />
```

| Contents of `name.txt` | Result |
| --- | --- |
| `"Ada"` | `"Ada"` |
| `"Ada\n"` | `"Ada\n"` |

The formatter leaves the source without a final newline. Adding one would
change the result when the file contains `"Ada"`.

## Keep a container fence with its Markdown item

A quoted fence remains literal even with an executable info string.

````xmd
> ~~~bash exec
> <File path="literal.txt" />
> ~~~
````

An unindented line leaves a list item and its open fence. The last tag
in this example reads the file, while the indented example stays literal.

````xmd
- Example

  ~~~
  <File path="literal.txt" />
<File path="actual.txt" />
````
