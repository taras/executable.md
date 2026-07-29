/**
 * One component, written two ways.
 *
 * Both forms acquire the same thing, and for now both own it for the length of
 * the invocation. Written with content that is exactly right — a wrapper's
 * resource should be alive while its content expands and gone afterwards.
 *
 * Written self-closing it is not: the handle it returns is for the caller to
 * use *afterwards*, by which point the resource behind it is already released.
 * The guide observes that rather than hiding it.
 */

import { hasContent, useContent } from "@executablemd/core";
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
  const handle = yield* useThing();
  if (yield* hasContent()) {
    return yield* useContent();
  }
  return handle;
}
