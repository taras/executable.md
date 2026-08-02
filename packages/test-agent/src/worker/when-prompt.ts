/**
 * The `<WhenPrompt>` component (specs/test-agent-spec.md §Behavior
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
import {
  env,
  hasContent,
  invocation,
  matchPrompt,
  parseTemplate,
  raise,
  registerComponents,
  tryContent,
} from "@executablemd/core";
import type {
  ComponentInvocationMetadata,
  ErrorSegment,
  ParsedTemplate,
  PropsSchema,
} from "@executablemd/core";

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

function configError(message: string): ErrorSegment {
  return { type: "error", message: `<WhenPrompt> ${message}`, source: "WhenPrompt" };
}

function formatLocation(metadata: ComponentInvocationMetadata): string {
  const position = metadata.position;
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
      return { prompt: offer.text, captures: outcome.value };
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

export function* installWhenPromptComponent(bridge: TurnBridge): Operation<void> {
  const ordinals = new Map<string, number>();

  function* WhenPrompt(props: Record<string, Json>): Operation<unknown> {
    const templateProp = props.template;
    const hasChildren = yield* hasContent();
    if (typeof templateProp === "string" && hasChildren) {
      const reported = yield* raise(
        configError("accepts either a template prop or children, not both."),
      );
      return reported.message;
    }
    let source: string;
    if (typeof templateProp === "string") {
      source = templateProp;
    } else if (hasChildren) {
      // tryContent(), not content(): the template is whatever the children
      // rendered, diagnostics included, exactly as renderSegments did here. A
      // body that genuinely stopped is a different thing and travels on.
      const projected = yield* tryContent();
      if (projected.failure !== undefined) {
        throw projected.failure;
      }
      source = projected.text.trim();
    } else {
      const reported = yield* raise(configError("requires a template prop or template children."));
      return reported.message;
    }

    const parsed = parseTemplate(source);
    if (!parsed.ok) {
      const reported = yield* raise(configError(parsed.error.message));
      return reported.message;
    }

    // The matcher resolves capture references against the caller's bindings.
    const currentEnv = yield* env;
    if (!currentEnv) {
      const reported = yield* raise(configError("requires an eval scope in context."));
      return reported.message;
    }

    const location = formatLocation(yield* invocation());
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
        return yield* awaitMatch(bridge, parsed.value, currentEnv.values);
      }),
    );

    // Returned rather than bound here: `as` is the engine's, and a return binds
    // by reference under it. A template with captures invoked without `as`
    // discards them — the component cannot see whether `as` was written.
    return record.captures;
  }

  // Registered inside the worker's execution, so it never reaches a user
  // document. `as` is absent from the schema: it is a reserved prop name and
  // declaring it would throw at registration.
  yield* registerComponents([
    {
      name: "WhenPrompt",
      origin: "@executablemd/test-agent/worker",
      fn: WhenPrompt,
      props: WHEN_PROMPT_PROPS,
    },
  ]);
}

const WHEN_PROMPT_PROPS: PropsSchema = {
  type: "object",
  properties: { template: { type: "string" } },
  additionalProperties: false,
};
