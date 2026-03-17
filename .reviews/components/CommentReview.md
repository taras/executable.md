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
    pairs.push({
      comment: current,
      code: next,
      file: lines[i].file,
      lineNumber: lines[i].lineNumber,
    });
  }
}

const hasPairs = pairs.length >= 3;
const pairsText = hasPairs
  ? pairs.map((p, i) =>
      `[${i}] COMMENT: ${p.comment}\nCODE: ${p.code}`
    ).join("\n---\n")
  : "";
```

<Show when={hasPairs}>

<Capture as="sampleResult">

<Sample>

Review these comment/code pairs. List ONLY obvious/redundant ones
where the comment restates what the code does.

Format each finding as: REDUNDANT[index]: comment text

If none are obvious: "No obvious comments found."

{pairsText}

</Sample>

</Capture>

```ts eval
const redundantIndices = [];
const indexPattern = /REDUNDANT\[(\d+)\]/g;
let m;
while ((m = indexPattern.exec(sampleResult)) !== null) {
  const idx = parseInt(m[1], 10);
  if (idx >= 0 && idx < pairs.length) redundantIndices.push(idx);
}

const redundantFindings = redundantIndices.map(i => pairs[i]);
const hasFindings = redundantFindings.length > 0;
```

<Show when={hasFindings}>

Redundant comments found — see inline suggestions.

<SuggestRemoval findings={redundantFindings} />

</Show>

</Show>
