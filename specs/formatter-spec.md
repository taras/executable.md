# XMD formatter

`xmd fmt` normalizes structural indentation in UTF-8 XMD source.
Formatting reads source without evaluating expressions, resolving components,
loading plugins, or executing XMD.

## Command forms

| Invocation | Selection and output |
| --- | --- |
| `xmd fmt`, `xmd fmt -h`, `xmd fmt --help` | Print usage to stdout. |
| `xmd fmt <file>` | Format the named regular file in place, regardless of its extension. |
| `xmd fmt <directory>` | Format eligible files recursively beneath the named directory. |
| `xmd fmt --check` | Use the directory selection rooted at the working directory. Print the paths of files that would change, relative to that directory, with one path and newline per entry. |
| `xmd fmt -` | Read stdin through EOF. Write exactly the formatted source to stdout. |

Directory selection uses the same glob traversal as `xmd test`. It selects
regular files with a case-sensitive `.md` suffix, including Markdown component
and test files, and skips descendants of `.git` and `node_modules` directories.
Git ignore rules do not participate. A directory search skips symbolic links.
An explicit target must itself be a regular file or directory. Paths are
literal. Spell a path beginning with a dash with a directory prefix, such as
`./-notes.md`. The command accepts at most one argument and no other options.
Directory results are ordered by relative path in UTF-16 code unit order.
Check mode uses forward slashes and never writes files.

File and directory formatting is silent and writes only changed files. Exit
status is 0 for success, 1 when check mode finds a difference, and 2 for
invalid arguments, invalid UTF-8, malformed source, or an I/O failure.
An error is reported on stderr with the input path or `<stdin>` when known.
Scanner errors include the authored line and column. A malformed file is left
unchanged and a malformed stdin document produces no stdout. Once directory
selection succeeds, the command attempts every selected file in path order and
reports each failure on stderr. Check mode then lists every valid file that
would change, even if some files failed. Any failure takes precedence over
check differences and sets exit status 2. In write mode, successful writes
remain in place when another file fails.

## Structural indentation

The formatter reads the same lexical frontmatter envelope as source inspection
and preserves its bytes, including a UTF-8 byte-order mark when present.
It uses the production XMD scanner and its shared Markdown boundaries for the
body. An incomplete component or executable fence, or a scanner refusal such
as a multiline opening tag that crosses its list item, is malformed. Markdown
that the scanner treats as passive stays passive, including a passive fence at
EOF and a backtick with no matching run. A later matching backtick run can
close an inline code span across lines, so subsequent text is scanned from
that closing run. In `Result<T>`, execution leaves the text passive and draft
inspection records an unfinished `<T>`. The formatter reports that unfinished
opening. The paired spelling `Result<T>x</T>` contains an executable element.

The [structural indentation rules](executable-mdx-spec.md#structural-indentation-and-standalone-lines)
and [examples](formatter-examples.md) define the body edits. At the start of
a line inside a block, add the entire two-space-per-level structural prefix
when the line lacks it. Keep content spaces and tabs after that prefix. Leave
empty lines bare and remove the structural prefix from lines whose only
content is that prefix and a line ending. Preserve line endings, the final
newline if present, and authored tag interiors. Apply the same structural
prefix rules to literal code while preserving the payload after prefix
removal.

The result must be a fixed point. If a proposed change alters the scanner's
component, text, or code segments, including passive fence slices, or another
pass would change the result, keep the original source. Rendered text, file
contents produced by executing the program, and significant whitespace are
preserved. Formatting may change authored positions and the behavior of
components that intentionally observe those positions. Diagnostics and source
inspection of the formatted document report the new positions.
