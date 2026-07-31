/**
 * What a form leaves behind.
 *
 * Only the validated response is journaled. A port, a token, a URL, whether a
 * browser opened — all of it belongs to the run that happened to serve the form,
 * and a replay that restored any of it would be describing a listener that no
 * longer exists.
 *
 * The description carries a fingerprint of what the person was actually asked:
 * the normalized schema, the normalized UI schema, and the sanitized content. A
 * document that changes the question changes the fingerprint, and the repository's
 * ordinary durability semantics take it from there — nothing here decides what a
 * mismatch means.
 */

import { createDurableOperation } from "@executablemd/durable-streams";
import type { Json as DurableJson, Workflow } from "@executablemd/durable-streams";
import { createHash } from "node:crypto";
import type { Operation } from "effection";

import type { Json, JsonObject } from "./json.ts";
import { parseJson } from "./json.ts";

const WEB_FORM = "web_form";

export interface FormQuestion {
  schema: JsonObject;
  uiSchema?: JsonObject;
  content: string;
}

/**
 * A stable name for what was asked.
 *
 * Object keys are sorted before hashing, because two schemas that differ only in
 * key order are the same question, and `JSON.stringify` would otherwise make them
 * different answers to replay.
 */
export function fingerprint(question: FormQuestion): string {
  const canonical = JSON.stringify({
    schema: canonicalize(question.schema),
    uiSchema: question.uiSchema === undefined ? null : canonicalize(question.uiSchema),
    content: question.content,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function canonicalize(value: Json): Json {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  const sorted: JsonObject = {};
  for (const key of Object.keys(value).sort()) {
    Object.defineProperty(sorted, key, {
      value: canonicalize(value[key]),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return sorted;
}

/**
 * Run a form once and record its answer, or restore the answer already recorded.
 *
 * On replay `live` is never entered, which is what keeps a resumed document from
 * binding a port, printing a URL, or asking anyone anything a second time.
 */
export function* persistResponse(
  identity: { location: string; fingerprint: string },
  live: () => Operation<Json>,
): Workflow<Json> {
  const stored = yield createDurableOperation<DurableJson>(
    { type: WEB_FORM, name: `webform:${identity.location}`, input: identity.fingerprint },
    function* (): Operation<DurableJson> {
      return asDurable(yield* live());
    },
  );
  return parseJson(stored);
}

/** The durable stream's `Json` and the package's are the same values, parsed once. */
function asDurable(value: Json): DurableJson {
  return parseJson(value);
}
