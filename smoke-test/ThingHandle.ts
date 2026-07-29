/**
 * Whether one particular handle's resource is still alive.
 *
 * `<ThingState />` answers "is anything live"; this answers "is *that* one",
 * which is what a caller holding a handle from a self-closing `<Thing />`
 * actually needs to know.
 */

import type { Json } from "@executablemd/core";
import type { Operation } from "effection";
import { isLive } from "./thing-registry.ts";

export const props = {
  type: "object",
  properties: {
    handle: { type: "string" },
  },
  required: ["handle"],
  additionalProperties: false,
};

// deno-lint-ignore require-yield
export default function* (props: Record<string, Json>): Operation<string> {
  return isLive(String(props.handle)) ? "live" : "released";
}
