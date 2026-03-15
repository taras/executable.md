/**
 * The `sample` modifier factory (spec §3.4).
 *
 * Wraps `exec` in the modifier chain. After the inner chain runs the
 * command, `sample` builds a SampleContext and delegates to the
 * Sample Api for LLM processing. The LLM response replaces the raw
 * command output.
 *
 * The Sample Api call is journaled via `createDurableOperation` so
 * that replays return the stored LLM response without re-calling the
 * inference server.
 *
 * Params from the info string (e.g., `sample=brief` or bracket
 * params like `sample[model=phi3-mini]`) are parsed and flow into
 * `SampleContext.params` and `SampleContext.model`.
 */

import type { ModifierFactory } from "../modifiers.ts";
import { useCodeBlock } from "../modifiers.ts";
import type { SampleContext } from "../types.ts";
import { durableSample } from "../sample/durable-sample.ts";

// ---------------------------------------------------------------------------
// Param parsing — extract model and text params from info string
// ---------------------------------------------------------------------------

/**
 * Parse bracket params like "model=phi3-mini" or plain params like "brief".
 *
 * Bracket params: `sample[model=phi3-mini]` → params="model=phi3-mini"
 * Plain params:   `sample=brief`            → params="brief"
 *
 * Returns { model, textParams } where model is extracted from bracket
 * key-value pairs and textParams is the remaining plain text.
 */
function parseSampleParams(
  params: string | undefined,
): { model?: string; textParams?: string } {
  if (!params) return {};

  // Check for key=value pairs (from bracket params)
  const kvMatch = params.match(/^(\w+)=(.+)$/);
  if (kvMatch) {
    const [, key, value] = kvMatch;
    if (key === "model") {
      return { model: value };
    }
    // Unknown key — treat whole thing as text params
    return { textParams: params };
  }

  // Plain text params (e.g., "brief", "passthrough")
  return { textParams: params };
}

// ---------------------------------------------------------------------------
// sampleFactory — wrapping modifier (spec §3.4)
// ---------------------------------------------------------------------------

export const sampleFactory: ModifierFactory = (params) =>
  (_args, next) =>
    (function* () {
      const ctx = yield* useCodeBlock();

      // Run inner chain (exec) to get command output
      const execResult = yield* next();

      // Parse params for model routing and text instructions
      const { model, textParams } = parseSampleParams(params);

      // Build SampleContext from exec result + code block metadata
      const sampleContext: SampleContext = {
        stdout: execResult.output,
        stderr: execResult.stderr,
        exitCode: execResult.exitCode,
        command: ctx.content,
        language: ctx.language,
        params: textParams,
        componentName: ctx.componentName,
        model,
      };

      // Journal the LLM call via durableSample (shared helper).
      // On replay, the stored response is returned without re-calling
      // the inference server.
      const commandPreview = ctx.content
        .slice(0, 30)
        .replace(/\n/g, " ");

      const sampledOutput = yield* durableSample(
        sampleContext,
        `sample:${commandPreview}`,
      );

      return {
        output: sampledOutput,
        exitCode: execResult.exitCode,
        stderr: execResult.stderr,
      };
    })();
