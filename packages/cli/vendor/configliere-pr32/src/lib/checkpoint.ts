import { dynamic } from "./dynamic.js";
import type { DynamicElement } from "./pipeline.js";
import { type ValueSource, withValues } from "./values.js";

export function checkpoint(): DynamicElement<
  ValueSource[],
  ReturnType<typeof withValues>
> {
  return dynamic((values: ValueSource[]) => withValues(values));
}
