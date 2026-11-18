import { parseJson } from "@executablemd/core";
import type { Json } from "@executablemd/core";
import { Err, Ok } from "effection";
import type { Operation, Result } from "effection";

export const props = {
  type: "object",
  properties: { text: { type: "string" } },
  required: ["text"],
  additionalProperties: false,
};
export const returns = { type: "object" };

export default function* Extract(props: Record<string, Json>): Operation<Json> {
  const input = props.text;
  if (typeof input !== "string") {
    throw new TypeError("Phase.Extract requires text.");
  }
  const parsed = readResult(input);
  if (!parsed.ok) {
    return {
      ok: false,
      rejection: {
        kind: "response_validation",
        code: "extraction",
        message: parsed.error.message,
        issues: [],
      },
    };
  }
  return { ok: true, json: JSON.stringify(parsed.value) };
}

function parseText(text: string): Result<Json> {
  try {
    return Ok(parseJson(JSON.parse(text)));
  } catch (error) {
    return Err(error);
  }
}

function opensRecord(text: string): boolean {
  return (
    /^\s*\{\s*(?:"|}|$)/.test(text) ||
    /^\s*\[\s*(?:\{|\[|"|\]|(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)(?=\s*(?:,|\]|$))|$)/.test(
      text,
    )
  );
}

function readResult(input: string): Result<Json> {
  const whole = parseText(input.trim());
  if (whole.ok) {
    return whole;
  }
  const candidates: Json[] = [];
  let outside = "";
  let fence: { marker: string; json: boolean; unlabeled: boolean; body: string } | undefined;
  for (const line of input.split(/(?<=\n)/)) {
    const delimiter =
      fence === undefined
        ? /(`{3,}|~{3,})([^\r\n]*)/.exec(line)
        : /^ {0,3}(`{3,}|~{3,})([^\r\n]*)/.exec(line);
    if (fence !== undefined) {
      if (
        delimiter &&
        delimiter[1][0] === fence.marker[0] &&
        delimiter[1].length >= fence.marker.length &&
        delimiter[2].trim() === ""
      ) {
        if (fence.json || (fence.unlabeled && opensRecord(fence.body))) {
          const parsed = parseText(fence.body);
          if (!parsed.ok) {
            return parsed;
          }
          candidates.push(parsed.value);
        }
        fence = undefined;
      } else {
        fence.body += line;
      }
    } else if (delimiter) {
      if (delimiter[2].includes(delimiter[1])) {
        outside += line;
        continue;
      }
      const language = delimiter[2].trim().toLowerCase();
      fence = {
        marker: delimiter[1],
        json: language === "json",
        unlabeled: language === "",
        body: "",
      };
      outside += line.slice(0, delimiter.index) + "\n";
    } else {
      outside += line;
    }
  }
  if (fence !== undefined) {
    return Err(new Error("The agent reply contains an unclosed code fence."));
  }
  for (let index = 0; index < outside.length; index += 1) {
    if (
      (outside[index] !== "{" && outside[index] !== "[") ||
      /[A-Za-z0-9_$]/.test(outside[index - 1] ?? "")
    ) {
      continue;
    }
    if (!opensRecord(outside.slice(index))) {
      continue;
    }
    const end = recordEnd(outside, index);
    if (!end.ok) {
      return end;
    }
    const parsed = parseText(outside.slice(index, end.value));
    if (!parsed.ok) {
      return parsed;
    }
    candidates.push(parsed.value);
    index = end.value - 1;
  }
  if (candidates.length !== 1) {
    return Err(new Error("The agent reply must contain exactly one unambiguous JSON result."));
  }
  return Ok(candidates[0]);
}

function recordEnd(text: string, start: number): Result<number> {
  const closings: string[] = [];
  let quoted = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        quoted = false;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === "{" || character === "[") {
      closings.push(character === "{" ? "}" : "]");
    } else if (character === "}" || character === "]") {
      if (character !== closings.pop()) {
        return Err(new Error("The agent reply contains an incomplete JSON result."));
      }
      if (closings.length === 0) {
        return Ok(index + 1);
      }
    }
  }
  return Err(new Error("The agent reply contains an incomplete JSON result."));
}
