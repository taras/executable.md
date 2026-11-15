import { resolve } from "node:path";
import { remark } from "remark";
import type { Evidence } from "./publication-receipt.ts";

const marker = "<!-- xmd-repl-ui-evidence:";
const end = "<!-- /xmd-repl-ui-evidence -->";
const start = (identity: string) => `${marker}v1 ${identity} -->`;
const parser = remark();
type Slot = Evidence["slots"][number];
type MarkdownNode = ReturnType<typeof parser.parse>["children"][number];
type Node = MarkdownNode | Extract<MarkdownNode, { type: "paragraph" }>["children"][number];

function visit(node: Node, check: (node: Node) => void): void {
  check(node);
  if ("children" in node) {
    for (const child of node.children) {
      visit(child, check);
    }
  }
}

export const pending = (slot: Slot) => `./${slot.filename}`;

function label(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/[^\p{L}\p{N} .,:;/+-]/gu, (char) => `&#${char.codePointAt(0)};`);
}

function slotAlt(slot: Slot): string {
  return `${slot.role === "before" ? "Before" : "After"} ${slot.checkpoint}`;
}

function imageCell(slot: Slot, destination: string): string {
  return `<!-- xmd-slot:${slot.id} ${slot.sha256} --> ![${slotAlt(slot)}](${destination})`;
}

function fixedMs(value: number): string {
  return value.toFixed(3);
}

function regexLiteral(part: string): string {
  return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function renderEvidence(evidence: Evidence, destinations: readonly string[]): string {
  const { identity, checkpoints, slots, timing } = evidence;
  return [
    start(identity),
    "",
    "## REPL UI evidence",
    "",
    "| Checkpoint | Fixture | Viewport | Action | Before | After |",
    "| --- | --- | --- | --- | --- | --- |",
    ...checkpoints.map(({ id, fixture, viewport, action }, index) => {
      const before = index * 2;
      return `| ${id} | ${label(fixture)} | ${viewport.columns} × ${viewport.rows} | ${label(action)} | ${imageCell(slots[before], destinations[before])} | ${imageCell(slots[before + 1], destinations[before + 1])} |`;
    }),
    "",
    "### Mounted typing latency",
    "",
    `Viewport ${timing.viewport.columns} × ${timing.viewport.rows}. Milliseconds from character dispatch to the completed emulator write containing the changed Message value.`,
    "",
    "| Workload | Samples per run | Before median | After median | Δ median | Before p95 | After p95 | Δ p95 |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...timing.workloads.map(
      ({ workload, baseline, candidate, deltaMs }) =>
        `| ${workload.name} | ${baseline.count} | ${fixedMs(baseline.medianMs)} | ${fixedMs(candidate.medianMs)} | ${fixedMs(deltaMs.median)} | ${fixedMs(baseline.p95Ms)} | ${fixedMs(candidate.p95Ms)} | ${fixedMs(deltaMs.p95)} |`,
    ),
    "",
    end,
  ].join("\n");
}

export function inspectBody(evidence: Evidence, body: string) {
  const first = body.indexOf(marker);
  const last = body.indexOf(end);
  const slots = evidence.slots.map(pending);
  if (first < 0 && last < 0) {
    return { present: false, before: "", after: body === "" ? "" : `\n\n${body}`, slots };
  }
  if (
    first < 0 ||
    last < first ||
    body.indexOf(marker, first + marker.length) >= 0 ||
    body.indexOf(end, last + end.length) >= 0
  ) {
    throw new Error("The draft has ambiguous evidence markers.");
  }
  const until = last + end.length;
  const section = body.slice(first, until);
  const skeleton = renderEvidence(
    evidence,
    slots.map(() => "\0"),
  );
  const matches = new RegExp(
    `^${skeleton.split("\0").map(regexLiteral).join("([^\\s()]+)")}$`,
  ).exec(section);
  if (matches === null) {
    throw new Error(
      "The draft evidence identity, layout or slot markers disagree with the receipt.",
    );
  }
  if (
    !parser
      .parse(body)
      .children.some(
        (node) =>
          node.type === "html" &&
          node.value === start(evidence.identity) &&
          node.position?.start.offset === first,
      )
  ) {
    throw new Error("The evidence section must be at the top level of the description.");
  }
  return {
    present: true,
    before: body.slice(0, first),
    after: body.slice(until),
    slots: matches.slice(1),
  };
}

function unescapePath(url: string): string {
  return url.replace(/\\([!-/:-@[-`{-~])/g, "$1");
}

function decodedPath(url: string): string {
  try {
    return decodeURIComponent(url);
  } catch {
    return url;
  }
}

export function checkAttachmentReferences(
  body: string,
  evidence: Evidence,
  destinations: readonly string[],
  directory: string,
  cwd: string,
) {
  const staged = new Map(
    evidence.slots.flatMap((slot, index) =>
      destinations[index] === pending(slot) ? [[resolve(directory, slot.filename), slot]] : [],
    ),
  );
  const seen = new Set<string>();
  const first = body.indexOf(marker);
  const last = body.indexOf(end);
  for (const child of parser.parse(body).children) {
    visit(child, (node) => {
      if (node.type !== "image" && node.type !== "link" && node.type !== "definition") {
        return;
      }
      if (/^(?:#|\/\/|[a-z][a-z\d+.-]+:)/i.test(node.url)) {
        return;
      }
      const spellings = [node.url, unescapePath(node.url)].flatMap((url) => [
        url,
        decodedPath(url),
      ]);
      const match = spellings
        .flatMap((url) => [resolve(directory, url), resolve(cwd, url)])
        .map((path) => staged.get(path))
        .find((slot) => slot !== undefined);
      if (match === undefined) {
        return;
      }
      const at = node.position?.start.offset ?? -1;
      if (
        node.type !== "image" ||
        node.url !== pending(match) ||
        at < first ||
        at >= last ||
        seen.has(match.id) ||
        node.alt !== slotAlt(match)
      ) {
        throw new Error("A staged image has a second or misplaced Markdown reference.");
      }
      seen.add(match.id);
    });
  }
  if (seen.size !== staged.size) {
    throw new Error("Every staged image needs its own visible Markdown slot.");
  }
}
