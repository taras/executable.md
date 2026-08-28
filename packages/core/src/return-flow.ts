import { createContext } from "effection";
import type { Context } from "effection";
import type { Json } from "@executablemd/durable-streams";
import type { ReturnsSchema } from "./types.ts";

/**
 * The value body a `<Return>` selects for (spec §6.10).
 *
 * A value root and a Markdown value component each publish one carrier for the
 * body it expands, and `<Return>` claims it. This is what lets a return be
 * written wherever the body's own flow reaches — under `<If>`, inside a
 * `<Loop>`, in content the caller projected — instead of only as a direct
 * top-level child.
 *
 * Ownership is `<Break>`'s, exactly (`LoopFrame`). `<If>`, `<Loop>`, `<Each>`
 * and `<Let>` keep the ambient carrier, because a return written under them is
 * written in the body the author could see. A component invocation publishes
 * `undefined` for its own body, so a `<Return>` a component writes belongs to
 * that component's own declaration and never to its caller's; a nested value
 * body then publishes a carrier of its own. Content the caller projected keeps
 * the caller's carrier, and every projection of one authored `<Return>`
 * restores the same carrier — which is what makes projecting it twice a
 * duplicate rather than two independent selections.
 *
 * ## Why the state is not in the context
 *
 * The context is named, and a named context is reachable by name from a
 * document's own eval block: `createContext("expand.return")` names the same
 * slot the engine publishes on. What travels through it is therefore a frozen
 * carrier that holds no facts — only one accessor, which answers nothing
 * without `UNLOCK`.
 *
 * `UNLOCK` is a `Symbol()` this module creates and never exports, so it cannot
 * be named, imported, or reconstructed: `Symbol()` is unforgeable, unlike a
 * `Symbol.for` key. A document can read the carrier, enumerate it with
 * `Reflect.ownKeys`, call what it finds, copy the carrier, or replace the
 * context with a look-alike — and reach nothing, because it has no token to
 * pass and a look-alike answers for no body at all. A `<Return>` that finds one
 * is reserved exactly as if no body owned it.
 *
 * The state lives in the closure the carrier was built around, so its lifetime
 * is that carrier's — one execution of one body — rather than the module's.
 * Nothing accumulates anywhere, and there is no table for a later run to read.
 *
 * This is the rule that says security enforcement never trusts replaceable
 * context state: selection decides which value crosses a declared schema, so it
 * cannot be a decision a document can make about itself.
 */
export interface ReturnCarrier {
  /** Answers only for the engine, which is the only holder of the token. */
  readonly open: (token: symbol) => ReturnState | undefined;
}

/**
 * The engine's proof that it is the engine.
 *
 * A `Symbol()` rather than a `Symbol.for()`: a registered symbol is a
 * process-global any code can ask for by name, and this one exists in no
 * registry and leaves this module through no export.
 */
const UNLOCK: unique symbol = Symbol("return-flow.open");

/**
 * The engine's mark on state it created.
 *
 * A carrier can be forged well enough to answer `open()` with something
 * state-shaped, so the token alone is not the whole check: what comes back is
 * only believed when it carries this mark. The key is a `Symbol()` that never
 * leaves this module, and a document never holds a real state to read it off,
 * so nothing outside can write it.
 */
const MINTED: unique symbol = Symbol("return-flow.state");

/** Everything a value body knows about its own return. Engine-private. */
interface ReturnState {
  readonly [MINTED]: true;
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

export const ActiveReturn: Context<ReturnCarrier | undefined> = createContext<
  ReturnCarrier | undefined
>("expand.return", undefined);

/**
 * Mint a carrier for one execution of one value body.
 *
 * Frozen and empty: there is nothing on it to read, and nothing to change. Its
 * only property is its identity, which is what `FRAMES` is keyed on.
 */
export function createReturnFrame(owner: string, returns: ReturnsSchema): ReturnCarrier {
  const state: ReturnState = {
    [MINTED]: true,
    owner,
    returns,
    claimed: false,
    selected: undefined,
  };
  return Object.freeze({
    open: (token: symbol) => (token === UNLOCK ? state : undefined),
  });
}

/**
 * The body a carrier stands for, or `undefined` when it stands for none.
 *
 * Every object this module did not mint answers `undefined`. A forgery without
 * an `open` is refused before it is called; one that supplies its own never
 * receives `UNLOCK` to compare against, and whatever it hands back lacks the
 * `MINTED` mark, so state-shaped is not state.
 */
function stateOf(carrier: ReturnCarrier | undefined): ReturnState | undefined {
  if (carrier === undefined || typeof carrier.open !== "function") {
    return undefined;
  }
  const state = carrier.open(UNLOCK);
  return state?.[MINTED] === true ? state : undefined;
}

/** What the owner of a body needs to run a `<Return>` found inside it. */
export interface OwningBody {
  owner: string;
  returns: ReturnsSchema;
}

/**
 * Take the body for the return about to execute, and say what it declares.
 *
 * Synchronous on purpose. The claim has to be recorded before the caller
 * suspends to evaluate the return's expression, so two returns racing through
 * one body cannot both believe they were first — the second throws here, having
 * evaluated nothing.
 *
 * Returns `undefined` when the carrier owns no body, which is the forged and
 * the absent case alike: the caller diagnoses the `<Return>` as reserved rather
 * than letting it select anything.
 */
export function claimReturn(carrier: ReturnCarrier | undefined): OwningBody | undefined {
  const state = stateOf(carrier);
  if (state === undefined) {
    return undefined;
  }
  if (state.claimed) {
    throw new Error(duplicateReturnMessage(state.owner));
  }
  state.claimed = true;
  return { owner: state.owner, returns: state.returns };
}

/**
 * Record the value the claiming return produced.
 *
 * Only a claimed body accepts one, so a value can be selected exactly where a
 * claim was taken and nowhere else.
 */
export function selectReturnValue(carrier: ReturnCarrier, value: Json): void {
  const state = stateOf(carrier);
  if (state !== undefined && state.claimed) {
    state.selected = { value };
  }
}

/**
 * What the body finally produced, read by its owner after the body and its
 * teardown have finished.
 *
 * The owner passes the carrier it minted and has held ever since, never one it
 * read back from the context — so replacing the context decides nothing here.
 */
export function settleReturn(carrier: ReturnCarrier): { value: Json } | undefined {
  return stateOf(carrier)?.selected;
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
