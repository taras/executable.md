import { brand, type IdentityElement } from "./pipeline.js";
import type { Definition } from "./types.js";

export function name<N extends string>(name: N): Definition<N> {
  return { name };
}

export function description(
  description: string,
): IdentityElement<Definition<string>> {
  return brand<IdentityElement<Definition<string>>>((
    definition: Definition<string>,
  ) => ({
    ...definition,
    description,
  }));
}
