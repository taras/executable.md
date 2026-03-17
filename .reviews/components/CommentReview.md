---
inputs:
  pr:
    type: object
    required: true
---

```ts eval
const pairs = [];
const lines = pr.added.filter(l => !l.isTest);

for (let i = 0; i < lines.length - 1; i++) {
  const current = lines[i].content.trim();
  const next = lines[i + 1].content.trim();
  if (current.startsWith("//") && !next.startsWith("//") && next.length > 0) {
    pairs.push({ comment: current, code: next });
  }
}

const hasPairs = pairs.length >= 3;
const pairsText = hasPairs
  ? pairs.slice(0, 20).map(p =>
      `COMMENT: ${p.comment}\nCODE: ${p.code}`
    ).join("\n---\n")
  : "";
```

<Show when={hasPairs}>

Redundant comments found:

<Sample>

Review these comment/code pairs. List ONLY obvious/redundant ones
where the comment restates what the code does.

Format: "- `<comment>` — restates `<code pattern>`"

If none are obvious: "No obvious comments found."

{pairsText}

</Sample>

</Show>
