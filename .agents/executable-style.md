# Executable.md Style Guide


An executable document is read twice: as source, by someone deciding whether to
trust what it does, and as output, by the person running it. Both readings are
designed. `components/BootstrapNpmPackage.md` is the worked example.

1. **Write prose that executes, not a script with comments.** Each step explains
   why it is necessary, performs it, and shows a useful result. The explanation
   is the document's content, not commentary around it.
2. **Explain a term where it first appears.** A document run once a year is run
   by someone who has not learned its vocabulary. Do not assume — educate.
3. **Lead with the practical consequence** rather than the principle, and
   address the reader as `you`.
4. **Report a completed action in the past tense.** A step that writes says that
   it wrote, and what. Announcing an intention beforehand does not replace it.
5. **Explain a refusal before it can happen**, and make it actionable: name the
   command that resolves it, filled in with what the run actually found.
6. **Keep machinery out of the output.** Captures, schemas, classifiers and
   bindings render nothing. A command whose own chatter reads worse than the
   document's sentence runs `silent`, and a command's raw output appears only
   where that output is the evidence.
7. **Put in `<Output>` only what the reader of a run can still act on.** How to
   invoke the document is read before it runs, so it belongs outside the region.

### Markdown > JavaScript/TypeScript > Bash/SH

Express each step at the highest level that can carry it, and say why when
dropping a level:

- **Markdown** for control flow, I/O and composition — `<If>`, `<Each>`,
  `<File>`, `<Parse>`, `<Let>`, `<TempDir>`, and components. It is the layer
  a reader can audit and the engine can journal and replay.
- **TypeScript** in `eval` blocks for comparison, classification and formatting.
  Typed, testable, and visible to the reader as a value rather than as text.
- **Shell** to invoke a program, and for little else. Parsing, branching and
  string assembly in shell are quoting hazards a reader cannot audit and a test
  cannot reach.

A document that needs a value from a command captures the command's output and
decides in TypeScript; it does not decide in the shell and report the verdict.

### Verifying a document

Render the output and read it as the person running it before calling the
document done. In a test, install `useNormalizedOutput()` — the CLI installs it
and `execute()` does not, so a raw capture shows whitespace the operator never
sees.

