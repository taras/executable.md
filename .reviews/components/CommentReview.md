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

Review these comment/code pairs. Return ONLY a JSON array of 0-based
indices where the comment is obviously redundant (restates what the
code already says).

If none are redundant: return []

Example response: [0, 3, 7]

{pairsText}

</Sample>

</Capture>

```ts eval
let indices = [];
try {
  const match = sampleResult.match(/\[[\d\s,]*\]/);
  if (match) indices = JSON.parse(match[0]);
} catch {}

const redundantFindings = indices
  .filter(i => typeof i === "number" && i >= 0 && i < pairs.length)
  .map(i => pairs[i]);

const hasFindings = redundantFindings.length > 0;
```

<Show when={hasFindings}>

Redundant comments found — see inline suggestions.

<SuggestRemoval findings={redundantFindings} />

</Show>

</Show>
