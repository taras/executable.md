import { toString } from "mdast-util-to-string";
import { remark } from "remark";
import { z } from "zod";
import { clear } from "../Ticket/text-storage.ts";

export const props = {
  type: "object",
  properties: {
    reference: { type: "string" },
    source: { type: "string" },
  },
  required: ["reference", "source"],
  additionalProperties: false,
};

function headingAnchor(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}_\s-]/gu, "")
    .replace(/\s/g, "-");
}

export default function* SpecSection(input: unknown) {
  const { reference, source } = z
    .strictObject({ reference: z.string(), source: z.string() })
    .parse(input);
  const anchor = decodeURIComponent(reference.slice(reference.indexOf("#") + 1));
  const headings = remark()
    .parse(source)
    .children.filter((node) => node.type === "heading");
  const matches = headings.filter(
    (heading) => headingAnchor(toString(heading, { includeHtml: false })) === anchor,
  );
  const [heading] = matches;
  if (matches.length !== 1 || heading?.position === undefined) {
    throw new Error("Select a unique spec section at " + reference + ".");
  }
  const next = headings
    .slice(headings.indexOf(heading) + 1)
    .find((candidate) => candidate.depth <= heading.depth);
  const section = source.slice(heading.position.start.offset, next?.position?.start.offset);
  yield* clear(section);
  return section;
}
