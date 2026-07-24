/**
 * The `<WhenPrompt>` vocabulary (specs/test-agent-spec.md §Behavior
 * documents). Each matcher signals the bridge that the previous stage's
 * rendering is complete, then suspends until an offered prompt matches.
 * A match is one durable `when_prompt` operation whose record restores
 * the matched prompt and captures on replay, so a rehydrated worker
 * advances to the active matcher without re-matching.
 */

import { scoped } from "effection";
import type { Operation } from "effection";
import { createDurableOperation } from "@executablemd/durable-streams";
import type { Json, Workflow } from "@executablemd/durable-streams";
import { Component, env, renderSegments, validateBindingName } from "@executablemd/core";
import type { ComponentInvocation, InvocationContext, Segment } from "@executablemd/core";
import { matchPrompt, parseTemplate } from "../template.ts";
import type { ParsedTemplate } from "../template.ts";
import type { TurnBridge } from "./bridge.ts";

const WHEN_PROMPT = "when_prompt";

interface StageRecord {
  prompt: string;
  captures: Record<string, string>;
}

function parseStageRecord(value: unknown): StageRecord | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  if (!("prompt" in value) || !("captures" in value)) {
    return undefined;
  }
  const { prompt, captures } = value;
  if (typeof prompt !== "string") {
    return undefined;
  }
  if (typeof captures !== "object" || captures === null || Array.isArray(captures)) {
    return undefined;
  }
  const parsed: Record<string, string> = {};
  for (const [name, text] of Object.entries(captures)) {
    if (typeof text !== "string") {
      return undefined;
    }
    parsed[name] = text;
  }
  return { prompt, captures: parsed };
}

function configError(message: string): Segment {
  return { type: "error", message: `<WhenPrompt> ${message}`, source: "WhenPrompt" };
}

function formatLocation(invocation: ComponentInvocation): string {
  const position = invocation.position;
  if (!position) {
    return "unknown";
  }
  const at = `${position.line}:${position.column}`;
  return position.path ? `${position.path}:${at}` : at;
}

/**
 * Waits for a matching prompt, answering every mismatch through its
 * offer so the ACP turn fails while the stage stays active.
 */
function* awaitMatch(
  bridge: TurnBridge,
  template: ParsedTemplate,
  bindings: Record<string, unknown>,
): Operation<StageRecord> {
  while (true) {
    const offer = yield* bridge.nextOffer();
    const outcome = matchPrompt(template, offer.text, bindings);
    offer.respond(outcome);
    if (outcome.ok) {
      return { prompt: offer.text, captures: outcome.captures };
    }
  }
}

function* persistStage(
  identity: { name: string; input: string },
  live: () => Operation<StageRecord>,
): Workflow<StageRecord> {
  const stored = yield createDurableOperation<Json>(
    { type: WHEN_PROMPT, name: identity.name, input: identity.input },
    function* (): Operation<Json> {
      const record = yield* live();
      return { prompt: record.prompt, captures: record.captures };
    },
  );
  const parsed = parseStageRecord(stored);
  if (!parsed) {
    throw new Error(`journaled when_prompt "${identity.name}" has an unexpected shape`);
  }
  return parsed;
}

export function* installWhenPromptVocabulary(bridge: TurnBridge): Operation<void> {
  const ordinals = new Map<string, number>();

  function* expandWhenPrompt(
    invocation: ComponentInvocation,
    ctx: InvocationContext,
  ): Operation<Segment[]> {
    for (const name of Object.keys({ ...invocation.props, ...invocation.expressions })) {
      if (name !== "template" && name !== "as") {
        return [configError(`does not accept a "${name}" prop (allowed: template, as).`)];
      }
    }
    const templateProp = invocation.props.template;
    const hasChildren = !invocation.selfClosing && invocation.children.length > 0;
    if (typeof templateProp === "string" && hasChildren) {
      return [configError("accepts either a template prop or children, not both.")];
    }
    let source: string;
    if (typeof templateProp === "string") {
      source = templateProp;
    } else if (hasChildren) {
      source = renderSegments(yield* ctx.expand(invocation.children)).trim();
    } else {
      return [configError("requires a template prop or template children.")];
    }

    const parsed = parseTemplate(source);
    if (!parsed.ok) {
      return [configError(parsed.error)];
    }
    const binding = invocation.props.as;
    if (parsed.template.captureNames.length > 0 && typeof binding !== "string") {
      return [configError('captures require an "as" prop.')];
    }
    let bindingName: string | undefined;
    if (binding !== undefined) {
      const validated = validateBindingName(binding);
      if (!validated.ok || validated.value === undefined) {
        return [configError('the "as" prop must be a valid binding name.')];
      }
      bindingName = validated.value;
    }

    const currentEnv = yield* env;
    if (!currentEnv) {
      return [configError("requires an eval scope in context.")];
    }

    const location = formatLocation(invocation);
    const ordinal = ordinals.get(location) ?? 0;
    ordinals.set(location, ordinal + 1);

    // The suspension signal lives inside the durable closure, so ONLY a
    // live matcher emits it: replayed stages resolve from the journal
    // and their re-rendered output never reaches a turn collector. For
    // a live matcher the signal completes the previous stage — it
    // follows all of that stage's output through one ordered channel,
    // so the collector never loses the final chunk.
    const record = yield* persistStage({ name: `when:${location}#${ordinal}`, input: source }, () =>
      scoped(function* () {
        yield* bridge.events.send({ kind: "suspended", stage: source });
        return yield* awaitMatch(bridge, parsed.template, currentEnv.values);
      }),
    );

    if (bindingName !== undefined) {
      const existing = currentEnv.values[bindingName];
      const merged: Record<string, unknown> =
        typeof existing === "object" && existing !== null && !Array.isArray(existing)
          ? { ...existing }
          : {};
      Object.assign(merged, record.captures);
      currentEnv.values[bindingName] = merged;
    }
    return [];
  }

  yield* Component.around({
    *expandInvocation([invocation, ctx], next) {
      if (invocation.name === "WhenPrompt") {
        return { segments: yield* expandWhenPrompt(invocation, ctx) };
      }
      return yield* next(invocation, ctx);
    },
  });
}
