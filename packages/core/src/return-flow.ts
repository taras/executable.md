import { createContext } from "effection";
import type { Context } from "effection";
import type { Json } from "@executablemd/durable-streams";
import type { ReturnsSchema } from "./types.ts";

/**
 * The value body a `<Return>` selects for (spec §6.10).
 *
 * A value root and a Markdown value component each publish one frame for the
 * body it expands, and `<Return>` claims it. This is what lets a return be
 * written wherever the body's own flow reaches — under `<If>`, inside a
 * `<Loop>`, in content the caller projected — instead of only as a direct
 * top-level child.
 *
 * Ownership is `<Break>`'s, exactly (`LoopFrame`). `<If>`, `<Loop>`, `<Each>`
 * and `<Let>` keep the ambient frame, because a return written under them is
 * written in the body the author could see. A component invocation publishes
 * `undefined` for its own body, so a `<Return>` a component writes belongs to
 * that component's own declaration and never to its caller's; a nested value
 * body then publishes a frame of its own. Content the caller projected keeps
 * the caller's frame, and every projection of one authored `<Return>` restores
 * the same frame object — which is what makes projecting it twice a duplicate
 * rather than two independent selections.
 *
 * The frame is composition state and nothing more: it lives for one expansion
 * of one body, carries no authority, appends no durable event, and is not
 * reachable from a document.
 */
export interface ReturnFrame {
  /**
   * Whose declaration this body satisfies. `__root__` names the root document,
   * and any other value is a component name — the two spell their diagnostics
   * differently, and the value's own validation errors are attributed here too.
   */
  owner: string;
  returns: ReturnsSchema;
  /**
   * Whether a `<Return>` has claimed this body. Set before the claiming return
   * evaluates its expression, so a second execution that arrives while the
   * first is still resolving observes the claim and evaluates nothing.
   */
  claimed: boolean;
  /** The validated value the claiming return selected, once it resolved. */
  selected: { value: Json } | undefined;
}

export const ActiveReturn: Context<ReturnFrame | undefined> = createContext<
  ReturnFrame | undefined
>("expand.return", undefined);

export function createReturnFrame(owner: string, returns: ReturnsSchema): ReturnFrame {
  return { owner, returns, claimed: false, selected: undefined };
}

/** How a body that executed no `<Return>` at all is reported. */
export function missingReturnMessage(owner: string): string {
  return owner === "__root__"
    ? "The root document declares `returns` but produced no <Return> value."
    : `<${owner} /> declares \`returns\` but produced no <Return> value.`;
}

/** How a body that executed a second `<Return>` is reported. */
export function duplicateReturnMessage(owner: string): string {
  return owner === "__root__"
    ? "The root document declares `returns` but executed more than one <Return>."
    : `<${owner} /> declares \`returns\` but executed more than one <Return>.`;
}

/**
 * Take the body for the return about to execute.
 *
 * Synchronous on purpose. The claim has to be recorded before the caller
 * suspends to evaluate the return's expression, so two returns racing through
 * one body cannot both believe they were first — the second throws here,
 * having evaluated nothing.
 */
export function claimReturn(frame: ReturnFrame): void {
  if (frame.claimed) {
    throw new Error(duplicateReturnMessage(frame.owner));
  }
  frame.claimed = true;
}
