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
  return { ok: true, json: JSON.stringify(parsed.value.value), span: parsed.value.span };
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

type Candidate = { value: Json; span: { start: number; end: number } };

function objectResult(value: Json, start: number, end: number): Result<Candidate> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return Err(new Error("The agent reply contains a non-object JSON result."));
  }
  return Ok({ value, span: { start, end } });
}

function readResult(input: string): Result<Candidate> {
  const trimmed = input.trim();
  const whole = parseText(trimmed);
  if (whole.ok) {
    const start = input.indexOf(trimmed);
    return objectResult(whole.value, start, start + trimmed.length);
  }
  const candidates: Candidate[] = [];
  let outside = "";
  let offset = 0;
  let fence:
    | { marker: string; json: boolean; unlabeled: boolean; body: string; start: number }
    | undefined;
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
          const start = fence.start + fence.body.length - fence.body.trimStart().length;
          const result = objectResult(parsed.value, start, start + fence.body.trim().length);
          if (!result.ok) {
            return result;
          }
          candidates.push(result.value);
        }
        fence = undefined;
      } else {
        fence.body += line;
      }
      // Preserve physical lines and UTF-16 positions while excluding fence contents.
      outside += line.replace(/[^\r\n]/g, " ");
    } else if (delimiter) {
      if (delimiter[2].includes(delimiter[1])) {
        outside += line;
        offset += line.length;
        continue;
      }
      const language = delimiter[2].trim().toLowerCase();
      fence = {
        marker: delimiter[1],
        json: language === "json",
        unlabeled: language === "",
        body: "",
        start: offset + line.length,
      };
      outside +=
        line.slice(0, delimiter.index) + line.slice(delimiter.index).replace(/[^\r\n]/g, " ");
    } else {
      outside += line;
    }
    offset += line.length;
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
    if (Array.isArray(parsed.value)) {
      const prefix = outside.slice(outside.lastIndexOf("\n", index - 1) + 1, index);
      if (prefix.trim() === "") {
        return Err(new Error("The agent reply contains a result-position JSON array."));
      }
    } else {
      const result = objectResult(parsed.value, index, end.value);
      if (!result.ok) {
        return result;
      }
      candidates.push(result.value);
    }
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
