/**
 * The two invocation forms, in one component.
 *
 * Written with content it is a wrapper: it reports that and renders what it
 * was given. Written self-closing it has nothing to wrap, so it allocates a
 * token instead and returns it — the shape `<TempDir />` will take.
 *
 * The allocation is retained, so the token stays live for the scope that
 * invoked the component rather than dying with it. `<ProbeLive />` is what
 * observes that from a later position in the document.
 */

import { hasContent, retain, useContent } from "@executablemd/core";
import { ensure, resource } from "effection";
import type { Operation } from "effection";
import { hold, nextToken, release } from "./probe-registry.ts";

export const props = {
  type: "object",
  properties: {},
  additionalProperties: false,
};

function useToken(): Operation<string> {
  return resource(function* (provide) {
    const token = nextToken("probe");
    hold(token);
    yield* ensure(() => release(token));
    yield* provide(token);
  });
}

export default function* (): Operation<string> {
  if (yield* hasContent()) {
    return `paired:${yield* useContent()}`;
  }
  return yield* retain(useToken);
}
