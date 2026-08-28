import type { Json } from "@executablemd/durable-streams";
import type { ReturnsSchema } from "./types.ts";

/**
 * The value body a `<Return>` selects for (spec §6.10).
 *
 * A value root and a Markdown value component each create one of these for the
 * body it expands, and `<Return>` claims it. This is what lets a return be
 * written wherever the body's own flow reaches — under `<If>`, inside a
 * `<Loop>`, in content the caller projected — instead of only as a direct
 * top-level child.
 *
 * Ownership is `<Break>`'s, exactly (`LoopFrame`), with one difference that
 * decides the whole shape of this module: a loop frame travels contextually,
 * and this does not.
 *
 * ## Why this is not in a context
 *
 * Selection decides which value crosses a declared schema, so it is
 * enforcement — and enforcement never trusts state a document can reach. A
 * document's own eval block can reach a great deal:
 *
 * - a **named context** by name, because `createContext("expand.return")` names
 *   the same slot the engine would publish on; and
 * - an **internal module** by file URL, because an eval block's imports are
 *   hoisted and resolved like any other module's.
 *
 * Between them, anything published contextually is readable, and any exported
 * function that acts on what was published is callable. A sealed carrier in a
 * context plus an exported `claim(carrier)` is forgeable however carefully the
 * carrier itself is sealed: the document calls the engine's own helper with the
 * engine's own carrier.
 *
 * So there is no carrier and no context. A `ReturnBody` is a plain object whose
 * operations are closures over state nothing else holds, and it reaches the
 * `<Return>` that claims it as an ordinary parameter of expansion — down the
 * call stack, which document code has no way to read or replace. Importing this
 * module gains a document nothing: `createReturnBody()` hands back a body of its
 * own, unconnected to any execution, and no exported function takes someone
 * else's.
 */
export interface ReturnBody {
  /**
   * Take the body for the return about to execute, and say what it declares.
   *
   * Synchronous on purpose. The claim is recorded before the caller suspends to
   * evaluate the return's expression, so two returns racing through one body
   * cannot both believe they were first — the second throws here, having
   * evaluated nothing.
   */
  claim(): { owner: string; returns: ReturnsSchema };
  /**
   * Record the value the claiming return produced. Only a claimed body accepts
   * one, so a value is selected exactly where a claim was taken.
   */
  select(value: Json): void;
  /**
   * What the body finally produced, read by its owner once the body and its
   * teardown have finished.
   */
  settle(): { value: Json } | undefined;
}

export function createReturnBody(owner: string, returns: ReturnsSchema): ReturnBody {
  let claimed = false;
  let selected: { value: Json } | undefined;

  return {
    claim() {
      if (claimed) {
        throw new Error(duplicateReturnMessage(owner));
      }
      claimed = true;
      return { owner, returns };
    },
    select(value: Json) {
      if (claimed) {
        selected = { value };
      }
    },
    settle() {
      return selected;
    },
  };
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
