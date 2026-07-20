<Section title="Smoke Test Summary">

This document exercises every feature of the system:

```bash exec
cat <<'TABLE'
| Feature                   | Exercised by                            |
|---------------------------|-----------------------------------------|
| Root frontmatter          | Title and version in opening paragraph  |
| Component with props      | <Section title>, <Note message>         |
| Required props            | <Note message> (message is required)    |
| Default props             | <Note> uses level=info by default       |
| Content slot              | <Section> wraps children via <Content/> |
| Nested expansion          | Section > Feature > Note (3 levels)     |
| Dotted component name     | <Tips.Formatting />                     |
| exec modifier             | Multiple bash exec blocks               |
| silent modifier           | bash silent exec block                  |
| Non-executable code       | yaml block (passthrough)                |
| Markdown healing          | Unclosed bold before <Badge />          |
| No-inputs component       | <Badge /> accepts zero props            |
| meta interpolation        | {meta.emoji} in Section and Note        |
| props interpolation       | {props.title}, {props.message}, etc.    |
| Props passthrough         | <PropDemo greeting="Hey" subject="w">  |
| Expression props          | <PropDemo greeting={dynamic} subject={dynamic}> |
| component as capture      | <Fragment as="capturedFromComponent">...       |
| Capture directive         | <Capture as="capturedInline">...               |
| Capture select            | <Capture select="code[lang=json]">...          |
| Durability                | Timestamp stable across reruns          |
| eval modifier             | js eval blocks with shared bindings     |
| persist modifier          | js persist eval block, resource lifetime|
| persist resource survival | spawn in persist eval + when() converge |
| timeout modifier          | js timeout=30s eval block               |
| eval + exec coexistence   | Both modifier types in same document    |
| findFreePort VM global    | yield* findFreePort() in eval block     |
| eval binding interpolation| {port} in exec block from eval binding  |
| daemon modifier           | bash daemon exec starts background proc |
| daemon + when readiness   | Daemon server polled until ready        |
| provider pattern          | StubProvider installs Sample middleware  |
| per-component eval scope  | Each provider gets isolated middleware   |
| props in env.values       | model prop available in eval blocks     |
| Sample component          | <Sample prompt>, <Sample> with children |
| output() function         | Sample component calls output()         |
| renderChildren() closure  | Sample component captures children      |
| Named slots               | <TwoColumn> with slot="left"/slot="right" |
| Fragment passthrough      | <Fragment slot="..."> wraps raw text       |
| Instruction component     | <Instruction system> wraps Sample calls |
| composable instructions   | Instructions enrich SampleContext.system |
| Text interpolation        | {textHost}:{textPort} in prose text     |
| Text + meta coexistence   | {meta.title} and {textPort} in same text|
| Escaped text bindings     | \{textPort} produces literal braces     |
| Verbatim unresolved       | {undefinedBinding} left as-is           |
| Non-string text coercion  | {itemCount} coerced via String()        |
TABLE
```

If you can read this table, every feature worked.

</Section>
