/**
 * Whether the resource behind a token issued earlier is still alive.
 *
 * Reads the registry `<Probe />` writes to, so a document can assert the
 * lifetime of a resource it never had a reference to.
 */

import type { Json } from "@executablemd/core";
import type { Operation } from "effection";
import { isLive } from "./probe-registry.ts";

export const props = {
  type: "object",
  properties: {
    token: { type: "string" },
  },
  required: ["token"],
  additionalProperties: false,
};

// deno-lint-ignore require-yield
export default function* (props: Record<string, Json>): Operation<string> {
  return isLive(String(props.token)) ? "live" : "released";
}
