import { z } from "zod";
import type { Operation } from "effection";

export const props = {
  type: "object",
  properties: { inputs: { type: "array", items: { type: "object" } } },
  required: ["inputs"],
  additionalProperties: false,
};
export const returns = { type: "array" };

export default function* Windows(input: unknown): Operation<unknown> {
  const { inputs } = z
    .object({ inputs: z.array(z.object({ path: z.string(), content: z.string() })) })
    .parse(input);
  return inputs.flatMap(({ path, content }) => {
    const windows = [];
    for (let start = 0; start < content.length; ) {
      let end = Math.min(start + 8000, content.length);
      if (
        end < content.length &&
        /[\uD800-\uDBFF]/.test(content[end - 1]) &&
        /[\uDC00-\uDFFF]/.test(content[end])
      ) {
        end -= 1;
      }
      windows.push({ source: path, start, end, content: content.slice(start, end) });
      start = end;
    }
    return windows;
  });
}
