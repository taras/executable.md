import { z } from "zod";
import { props, checkCheckout } from "./Checkout.ts";

const input = z.strictObject({ root: z.string().min(1) });
export { props };

// deno-lint-ignore require-yield
export default function* CheckoutCheck(value: unknown) {
  const { root } = input.parse(value);
  return () => checkCheckout(root);
}
