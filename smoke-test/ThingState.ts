/**
 * Whether any `<Thing>` resource is alive at this point in the document.
 *
 * Renders `live` or `none`, so a document can observe a lifetime beginning and
 * ending without ever naming a handle.
 */

import type { Operation } from "effection";
import { anyLive } from "./thing-registry.ts";

export const props = {
  type: "object",
  properties: {},
  additionalProperties: false,
};

// deno-lint-ignore require-yield
export default function* (): Operation<string> {
  return anyLive() ? "live" : "none";
}
