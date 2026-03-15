/**
 * EMA globals — re-exported for use in generated eval modules.
 *
 * When eval blocks are compiled into data: URI modules, they need to
 * import EMA-specific APIs (Sample, callLlamafile, etc.). This module
 * provides those imports under a stable package export path:
 *
 *   import { Sample, findFreePort } from "@executablemd/core/globals";
 */

// Content context — useContent() for function components
export { useContent } from "./src/content-context.ts";

// Port allocation
export { findFreePort } from "./src/find-free-port.ts";

// Sample Api — middleware for LLM inference routing
export { Sample } from "./src/sample-api.ts";

// LLM inference HTTP utilities
export { callLlamafile } from "./src/sample/llamafile.ts";
export { callOllama } from "./src/sample/ollama.ts";
export { callAnthropic } from "./src/sample/anthropic.ts";
