/**
 * One component, one resource, two lifetimes.
 *
 * Both forms acquire the same thing. What differs is who owns it: written with
 * content this is a wrapper, so the resource belongs to the invocation and is
 * released when the wrapping finishes; written self-closing there is nothing
 * to wrap and the handle is for the caller to use afterwards, so the resource
 * is retained at the invocation site instead.
 */

import { content, hasContent, retain } from "@executablemd/core";
import { ensure, resource } from "effection";
import type { Operation } from "effection";
import { hold, nextHandle, release } from "./thing-registry.ts";

export const props = {
  type: "object",
  properties: {},
  additionalProperties: false,
};

function useThing(): Operation<string> {
  return resource(function* (provide) {
    const handle = nextHandle();
    hold(handle);
    yield* ensure(() => release(handle));
    yield* provide(handle);
  });
}

export default function* (): Operation<string> {
  if (yield* hasContent()) {
    yield* useThing();
    return yield* content();
  }
  return yield* retain(useThing);
}
