import { brand, type Extension, type Unary } from "./pipeline.js";

export function extend<const E extends readonly Unary[]>(
  ...elements: E
): Extension<E> {
  return brand<Extension<E>>((start: unknown): unknown =>
    elements.reduce<unknown>(
      (value, element) => element(value as never),
      start,
    )
  );
}
