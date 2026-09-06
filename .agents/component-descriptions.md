# Component descriptions

A component description follows the general product-interface rules and review
process in [product-interface.md](product-interface.md). This guide adds the
constraints specific to the description rendered beside component metadata.

A component description helps a document author decide what to type. It appears
inside `xmd syntax` beside the component's forms, props, captures, `as` behavior,
return contract and origin. Write it as the short practical explanation those
structured fields cannot provide, not as a second reference entry.

## Rules

1. Lead with an imperative.

   Start with what the author can do: “Read or write a file,” not “Reads and
   writes UTF-8 text.”

2. Lead with purpose, not mechanism.

   `<Session.Launch>` launches a coding agent with prepared context. Terminal
   ownership and provider setup are secondary details.

3. Show a representative invocation.

   Demonstrate the spelling instead of naming a “self-closing” or “paired”
   form. The example is concrete and can be copied into a document.

4. Write for the Markdown author.

   Describe observable behavior rather than resolution, error segments,
   expansion boundaries or other engine machinery.

5. Do not repeat the structured fields.

   Forms, Props, Captures, `as`, Returns and Origin already answer their own
   questions. Mention one only when it explains a choice or a surprising
   consequence.

6. Cut what the reader can infer.

   Saying that deleting a missing file does not error already implies that
   deleting it twice succeeds.

7. Do not defend an absence.

   “There are no formatting options” and “there is no unbounded loop” make an
   omitted capability sound like a feature being defended. Leave it out unless
   the refusal changes how the component is used.

8. Do not answer a question nobody asked.

   Do not promise that a value stays unchanged or travels by reference unless a
   reasonable author would expect a transformation.

9. Keep behavior that changes use.

   Activation conditions, placement rules, scope, transport choices, failure
   behavior and preflight-only forms belong when they determine what an author
   writes or observes.

10. State conditions before apparently unconditional behavior.

    Explain when `<Test>` runs before saying what happens when it runs.

11. Name scope precisely.

    Say “in its content” rather than “inside.” State when a component reaches
    work performed by nested components.

12. Prefer the exact recognizable term.

    “Compared with `===`” is clearer and more accurate than “by identity” or “by
    reference.” Name `<Elicit>` rather than “questions” when another question
    component follows a different path.

13. Use parallel descriptions for related components.

    Give `<Parse>` and `<SafeParse>` the same sentence structure so their
    differing failure behavior is visible at a glance.

14. Describe present behavior.

    Avoid roadmap qualifiers such as “currently.”

A description is complete when it states the purpose, shows how to invoke the
component, and includes only the additional facts an author needs to use it
correctly.

## Refinement interview

Use the Product Owner interview in [architect.md](architect.md). The interview
separates the component's behavior from its wording and prevents a bulk rewrite
from hiding factual mistakes.

### Prepare the pass

1. Inventory every description in scope and count them.
2. Read the declarations, implementation and specifications that decide each
   component's behavior.
3. Group related components so established wording can carry into a family, but
   review one component at a time.

### Review one component

Apply the general five-part interview with these description-specific details:

1. **Current:** quote the existing description verbatim.
2. **Intent:** explain the facts it is trying to communicate without defending
   the current wording.
3. **Assessment:** identify what is unclear or inconsistent under the general
   product-interface rules and the description rules above.
4. **Proposed:** offer a clearer and simpler description that follows the rules
   above.
5. **Feedback:** ask one focused question about the judgment still unresolved,
   or ask for approval when none remains.

Do not move to the next component until the reader answers. Apply an accepted
description immediately and keep a visible count of completed entries.

### Carry feedback through the corpus

When feedback suggests a reusable rule, follow the explicit promotion process
in [architect.md](architect.md). Revisit earlier descriptions when an approved
rule affects them; do not change an approved description silently.

Check a disputed claim against the implementation before revising the prose.
The description must remain accurate even when the most approachable wording is
less precise. Treat a factual correction separately from a style improvement so
the final record says when the documented contract changed.

When the interview exposes a missing architectural term or a product decision,
update its authoritative source or raise it for a separate decision. Do not
smuggle the decision into description wording.

### Finish the pass

1. Render the complete `xmd syntax` output and read it as a document author.
2. Compare related entries side by side and make their common structure and
   meaningful differences visible.
3. Scan the entire corpus for the rules established during the interview, such
   as every entry carrying a representative invocation.
4. Run formatting, lint, typechecking and the focused syntax-catalog evidence
   appropriate to the files changed.
5. Record style changes separately from corrections of substance in the commit
   and pull-request description.
