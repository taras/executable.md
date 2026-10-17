# PR 2: canonical source inspection interview

Status: all four items are accepted by the Product Owner.
The invocation boundary, five presentation decisions and main
verification journey are accepted. Static source inspection completes the
cross-package contract in the Planner handoff. This does not reopen the
middleware request or add persistence.

## Purpose and current gap

After admission, the REPL displays generated XMD in place of Evaluate's inner
producer content. It must preserve Evaluate's opening and closing tags. Core's
current Expansion position identifies the opening character; it does not supply
the end of the opening tag or beginning of the closing tag.

The canonical scanner already decides those boundaries while reading component
attributes, nested content, fences and inline code. Its private parse result
contains the end position, and its private top-level ComponentSpan collection
supports heading discovery. Public ComponentElement exposes only an opening
position. Reconstructing the missing boundaries with a CLI parser would create
another account of XMD syntax.

The REPL also needs this map on a cold read, when no component is executing.
Adding ranges to live middleware would leave that case unanswered. The existing
parseMarkdownDefinition operation compiles declarations and builds an executable
definition; static presentation needs only lexical source ranges. In particular,
inspection must not invoke a frontmatter language evaluator, compile schemas,
evaluate prop expressions or execute code blocks.

## System-boundary interview

Trigger: a new public Core function and multi-member returned description crosses
the Core/CLI boundary. Review **four items** before freezing the contract:

1. `inspectSource(text, kind)`: the static reading operation and its input form.
2. `SourceElement.name`: the authored element's name.
3. `SourceElement.opening`: the complete opening or self-closing tag range.
4. `SourceElement.closing`: the closing-tag range for a paired element.

Reuse the existing Core SourceRange shape, `readonly start` and `readonly end`,
instead of introducing another interval type. Existing document-target ranges
remain body-relative; inspection ranges are relative to the exact string handed
to this function. Every range is a half-open UTF-16 string slice, matching the
scanner's existing offset arithmetic. Source-range offsets are not terminal
cell measurements.

The names and returned shape below are accepted. Local collector mechanics
remain delegated. No contextual runtime
API, new namespace or public parent/process key is proposed.

## Item 1 of 4: inspectSource

**Feature.** Let the REPL locate executable element tags in retained source,
including while inspecting an earlier checkpoint or opening a completed run.

**Example.** For the packet's paired Evaluate, opening and closing ranges let the
display preserve both tags and replace only the string between them. A literal
`<Evaluate>` inside a code fence must not become a replacement target.

**Current.** Core's scanner records complete top-level component spans privately.
It knows nested elements and exact delimiter positions during parsing. The
public definition parser returns ComponentElement positions and executable
definitions rather than this detached range reading.

**Accepted interface.**

```ts
/**
 * Read executable element boundaries from source without executing it.
 * Document input excludes frontmatter from executable scanning; fragment input
 * follows generated expansion's whole-string scanning behavior.
 * Ranges index the exact input string, including any document header prefix.
 */
function inspectSource(
  text: string,
  kind: "document" | "fragment",
): Result<readonly SourceElement[]>;
```

`document` follows Core's authored Markdown source envelope. `fragment` follows
the generated expansion path, which scans the complete produced string. The
caller selects from the retained source region's known kind, not from filename
guessing or header-looking content. The parameter is required because these
parsing paths have different frontmatter semantics.

The function is synchronous and pure: no filesystem, provider, context lookup,
import, frontmatter evaluator, schema compiler or executable-definition factory.
It reuses Core's scanner boundary decisions and returns a detached, recursively
frozen list. Entries include every recognized nested executable element in
opening-source order. Parent relationships follow interval containment; the
REPL supplies its own private view composition. This is syntax, not a claim
that an element resolved, ran or received permission.

Ordinary passive text yields no element entry. An incomplete tag follows the
canonical scanner's passive-text behavior; a scanner refusal returns Err rather
than a guessed boundary. Core's scanning exceptions become Error failures.
An empty list is successful absence of recognized executable tags, not a failed
inspection. The REPL separately refuses replacement when a retained admission
cannot be matched to one canonical paired Evaluate at its recorded position.

Keep original bytes, source positions and existing execution decisions unchanged.
Document-envelope extraction preserves the same body boundary as execution while
reading no frontmatter value; it must not call a user language evaluator even
if that language was used when the document originally ran. No persistent
metadata or Journal change is necessary.

Export this pure engine helper and its types from Core's existing root entrypoint,
alongside its parsing helpers. Consumer-facing contextual Component operations
remain on /api under architecture rule 7. No new subpath or dependency is needed.

**Decision for item 1: accepted.** The Product Owner accepts the pure Core
inspectSource function with explicit document/fragment input, Result reporting
and a detached readonly source-element list. The returned members remain under
review. Static inspection does not execute the source or evaluate expressions.

## Item 2 of 4: name

**Feature.** Identify the authored element at each range, so the REPL can match
a generated admission to Evaluate and label source without resolving a component.

**Example.** The inspected outer tag in the packet carries `name: "Evaluate"`;
its producer carries `name: "Plan"`. Two Evaluate tags have the same name but
different opening positions. A dotted tag such as `<File.Delete ... />` retains
`"File.Delete"` exactly. The name alone identifies neither a unique occurrence
nor a permitted definition.

**Current.** Core's scanner reads the authored spelling into ComponentElement.name.
The existing Expansion description also reports the authored name for an actual
invocation. Source inspection reuses that spelling without requiring an invocation.

**Proposed member.**

```ts
interface SourceElement {
  /** The authored tag name, exactly as Core's scanner reads it. */
  readonly name: string;
}
```

This member is required because every recognized executable element has a name.
Preserve its case and dotted spelling; do not substitute a resolved definition
name, package origin, registry identity or user-facing label. The value is a
detached immutable string with the inspected source description's lifetime.
Reading it performs no import or permission check. An unresolved authored name
can still have a source range, without being reported as having executed.

The REPL uses the name together with the retained source owner and exact opening
position when matching Evaluate. It does not merge repeated names, assign a
process identity from them or infer a lifecycle phase. Retained source kind and
canonical position, not the name, establish which source string owns the range.

**Assessment.** `name` and `string` match Core's existing parsed and live
description vocabulary. No enum of currently installed components can represent
all custom authored tags. No additional display-name field is needed.

**Decision for item 2: accepted.** The Product Owner accepts required readonly
name as the exact authored tag spelling, independent of resolution and execution.

## Item 3 of 4: opening

**Feature.** Preserve an element's exact opening tag when the display replaces
its content or draws a source rail.

**Example.** In `<Evaluate>body</Evaluate>`, opening is `{ start: 0, end: 10 }`:
`text.slice(opening.start, opening.end)` returns `<Evaluate>`. For
`<Evaluate text={program} />`, the range covers that entire self-closing tag.
Attributes and their authored whitespace remain in the slice.

**Current.** ComponentElement.position marks the opening character. The canonical
scanner knows the point immediately after `>` or `/>`, having read attributes
with its existing quote/expression handling. That point is not currently part
of the public source description.

**Proposed member.**

```ts
interface SourceElement {
  /** Complete opening or self-closing tag, as a half-open slice of input text. */
  readonly opening: SourceRange;
}
```

The member is required for every recognized element. Its start includes `<`;
its end excludes the character after `>` and therefore includes the entire tag.
Both bounds are zero-based UTF-16 string offsets in the exact inspectSource input.
For a document, they include the original header prefix; for a fragment, they
index the complete produced string. This follows SourcePosition.offset arithmetic
and the existing SourceRange start/end vocabulary. Existing document-target
range coordinates remain unchanged.

Core returns a frozen range with integer bounds satisfying
`0 <= start < end <= text.length`. The range has no file, admission id, live
occurrence key, line/column duplication or terminal-cell coordinate. The caller
already owns the retained source string and its provenance. Applying a range
to a different string would describe different source; display wrapping never
changes the string these bounds index.

Read the boundary from the canonical parse decision, including a tag containing
`>` inside a quoted attribute or expression. Do not search for the first `>`
after a recorded position. A multiline opening tag remains one range and one
element, regardless of how many visual rows it occupies.

**Assessment.** `opening` distinguishes the tag from the whole element and its
inner content. Required SourceRange preserves exact spelling without exposing
parsed props or executable definitions. The closing boundary is the next item.

**Decision for item 3: accepted.** The Product Owner accepts required opening as
the exact half-open range of the opening or complete self-closing tag. Attributes
remain in the slice and visual wrapping changes none of its offsets.

## Item 4 of 4: closing

**Feature.** Preserve a paired element's exact closing tag and identify the end
of the content replaced in the source reading.

**Example.** In `<Evaluate>body</Evaluate>`, closing is `{ start: 14, end: 25 }`.
The closing slice is `</Evaluate>` and the inner slice, from opening.end to
closing.start, is `body`. In `<Evaluate></Evaluate>`, that inner slice is empty
but closing is still present. A self-closing `<Evaluate text={program} />`
has no closing range.

**Current.** Core's parseChildren identifies the matching closing tag after
reading nested children and returns the position after it. The boundary is
currently private; an opening SourcePosition alone cannot identify it safely.

**Proposed member.**

```ts
interface SourceElement {
  /** Complete closing tag for a paired element; absent for a self-closing tag. */
  readonly closing?: SourceRange;
}
```

The optional member is absent exactly when the recognized element is self-closing.
It is present for every recognized paired element, including one with empty
content. Absence never means that a close is still expected, execution is running,
inspection failed or the data is unknown. An incomplete paired tag follows the
canonical scanner's passive-text behavior, not a guessed paired SourceElement.

Like opening, closing is a detached frozen range indexing the exact input string.
Its start includes the closing tag's `<` and its end is immediately after `>`.
For a paired element, Core guarantees
`opening.end <= closing.start < closing.end <= text.length`. The spelling and
whitespace belong to the actual tag recognized by Core. This is source syntax;
it says nothing about runtime cleanup or the invocation's terminal outcome.

The REPL derives the inner content with
`text.slice(opening.end, closing.start)` and the whole paired element with
`text.slice(opening.start, closing.end)`. The whole self-closing element is its
opening slice. Interval containment supplies static nesting without public
children, parent keys or another stored content range.

Read the matching close from the successful canonical parse, including nested
same-name elements and inert tag-like strings. A text search for the next
`</Name>` is not equivalent. Freeze both ranges before returning the description;
neither carries a live handle or gets updated by execution phases.

**Assessment.** `closing?: SourceRange` expresses the two existing authored
forms without duplicating a selfClosing flag. Its absence has one precise
meaning, and opening/closing use parallel names and interval semantics.

**Decision for item 4: accepted.** The Product Owner accepts optional closing,
present for every paired element and absent exactly for self-closing elements.
It is a source boundary with no lifecycle meaning. All four items are settled.

## Accepted boundary shape

```ts
interface SourceElement {
  /** The authored tag name, exactly as Core's scanner reads it. */
  readonly name: string;
  /** Complete opening or self-closing tag, as a half-open slice of input text. */
  readonly opening: SourceRange;
  /** Complete closing tag for a paired element; absent for a self-closing tag. */
  readonly closing?: SourceRange;
}

// Existing Core interval shape, exported for this consumer.
interface SourceRange {
  readonly start: number;
  readonly end: number;
}
```

The accepted opening range covers `<Name ...>` or the entire `<Name ... />`.
The accepted closing range covers `</Name>` and is absent exactly for a
self-closing element. For a paired element, its inner content is the slice from
opening.end to closing.start. No content range, whole-element range, parsed
props, definitions, children array or parent key duplicates these boundaries.

## Derived evidence for the Planner

Compare static boundaries with actual execution scanning for documents and
generated fragments. Include nested same-name tags, tag-like strings inside
attributes, code fences and inline code, CRLF, non-ASCII offsets and empty paired
content. Document headers containing tag-like text are excluded from document
scanning without running their parser; generated fragments retain their existing
whole-string behavior. Existing heading target discovery and execution parsing
remain unchanged. Cold inspection has no provider call, source load or Journal
mutation. Malformed/ambiguous admission positions still refuse replacement.

The implementation collects ranges where the canonical parser recognizes them;
it does not reconstruct closing delimiters by text search after parsing. Keep
the scanner's existing top-level spans for heading masking equivalent. The exact
private metadata collector and focused tests belong to the conforming plan.

The accepted boundary is consolidated with the invocation and presentation
contracts in [pr2-planner-handoff.md](pr2-planner-handoff.md). PR 2 is ready for
planning; the Planner freezes the implementation plan and its focused evidence.
