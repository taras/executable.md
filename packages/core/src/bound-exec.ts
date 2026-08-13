/**
 * The capability-backed request a bound command is executed through.
 *
 * `exec as="name"` turns a command's exit status into data, so two facts decide
 * what the document ends up believing: that this block is bound — which is what
 * authorizes its chain to be composed only from the built-in exec terminal and
 * the built-in `timeout` — and what the process actually settled to.
 *
 * Neither can travel as ordinary block data. `Component.applyModifiers` is a
 * supported public override surface: a handler may rewrite the context it
 * delegates and may answer with a `CodeBlockResult` of its own. A handler that
 * removed the bound fact would have the block composed as an ordinary one —
 * `silent exec as="probe"` would compose and start a child — and a handler that
 * invented an outcome would decide what the document read.
 *
 * So a bound block is asked for through a request only this module issues, and
 * canonical core composes the chain against the context it kept rather than the
 * one that came back. Middleware still composes around the operation: it may
 * observe it, refuse it by throwing, and delegate it. What it cannot do is
 * produce the outcome — whatever it returns is ignored, a failure canonical
 * execution raised stays raised even if it is caught, and a request that was
 * not issued here, was issued for another block, or has already been claimed
 * runs nothing at all.
 */

import type { Operation } from "effection";
import type {
  CodeBlockContext,
  CodeBlockResult,
  ExecResult,
  Modifier,
  SourcePosition,
} from "./types.ts";

/** A protocol violation by whoever is composed around a bound command. */
export class BoundExecProtocolError extends Error {
  override name = "BoundExecProtocolError";

  constructor(problem: string) {
    super(
      `Component.applyBoundModifiers middleware ${problem}. A handler may inspect, refuse ` +
        "or delegate a bound command; only canonical execution runs one.",
    );
  }
}

/**
 * What a handler is given for a bound block.
 *
 * An ordinary block context, so instrumentation reads the same members it
 * always did — and no more than that: the fact that authorizes this block, and
 * the outcome it settles to, are held where nothing that passes through
 * middleware can reach them.
 */
export type BoundExecRequest = CodeBlockContext;

/** One bound block's private state. */
class BoundBlock {
  consumed = false;
  outcome: ExecResult | undefined;
  /** A canonical failure, kept whether or not middleware caught it. */
  failure: { raised: unknown } | undefined;

  /**
   * The chain the document wrote and the context it was expanded with.
   *
   * Snapshotted here and never handed out: a handler holds the request instead,
   * so rewriting what it delegates — dropping a refused word from the array,
   * mutating a modifier in place afterwards, replacing the command — changes
   * what this block executes not at all. Both are frozen because the arrays and
   * objects the scanner produced go on being reachable from the segment.
   */
  readonly authored: readonly Modifier[];

  constructor(
    modifiers: readonly Modifier[],
    readonly context: CodeBlockContext,
  ) {
    this.authored = Object.freeze(
      modifiers.map((modifier) =>
        Object.freeze(
          modifier.params === undefined
            ? { name: modifier.name }
            : { name: modifier.name, params: modifier.params },
        ),
      ),
    );
  }
}

class CanonicalBoundRequest implements CodeBlockContext {
  readonly #block: BoundBlock;
  readonly language: string;
  readonly content: string;
  readonly blockId: string;
  readonly componentName?: string;
  readonly position?: Readonly<SourcePosition>;

  constructor(block: BoundBlock) {
    this.#block = block;
    this.language = block.context.language;
    this.content = block.context.content;
    this.blockId = block.context.blockId;
    if (block.context.componentName !== undefined) {
      this.componentName = block.context.componentName;
    }
    if (block.context.position !== undefined) {
      this.position = block.context.position;
    }
    Object.freeze(this);
  }

  /** The block `request` speaks for, once, or the refusal saying why it speaks for none. */
  static claim(request: unknown): BoundBlock {
    if (!CanonicalBoundRequest.own(request)) {
      throw new BoundExecProtocolError("delegated a request canonical execution did not issue");
    }
    const block = request.#block;
    if (block.consumed) {
      throw new BoundExecProtocolError("delegated a bound command more than once");
    }
    block.consumed = true;
    return block;
  }

  /** Whether this class built `value`, answered without trusting it. */
  static own(value: unknown): value is CanonicalBoundRequest {
    if (typeof value !== "object" || value === null) {
      return false;
    }
    try {
      return #block in value;
    } catch {
      return false;
    }
  }
}

/** What canonical execution produced for one bound block. */
export type BoundSettlement =
  /** The authorized chain ran and the process settled to this exact outcome. */
  | { readonly status: "produced"; readonly outcome: ExecResult }
  /** Canonical execution raised this exact failure. Not middleware's to rescue. */
  | { readonly status: "raised"; readonly raised: unknown }
  /** The terminal was never reached, so no command ran and nothing is bound. */
  | { readonly status: "absent"; readonly refusal: BoundExecProtocolError };

/** One bound block's request, and what canonical core reads back from it. */
export interface IssuedBoundExec {
  readonly request: BoundExecRequest;
  /**
   * What canonical execution settled to.
   *
   * Readable whether or not the public chain returned normally, so a handler
   * that catches what canonical execution raised cannot turn it into silence.
   */
  settlement(): BoundSettlement;
}

/**
 * Compose and run the authorized chain for one issued request, once.
 *
 * Canonical core's terminal calls this with whatever middleware delegated. The
 * chain and the context are the ones that block was *issued* with, so a
 * rewritten, copied or fabricated request — and a delegated modifier array with
 * a refused word removed — runs nothing rather than running something else. `run` is canonical core's own composition: it is reached only
 * from here, so a handler that does not delegate never reaches it.
 */
export function* claimBoundExec(
  request: unknown,
  run: (modifiers: readonly Modifier[], context: CodeBlockContext) => Operation<CodeBlockResult>,
): Operation<void> {
  const block = CanonicalBoundRequest.claim(request);
  let result: CodeBlockResult;
  try {
    result = yield* run(block.authored, block.context);
  } catch (error) {
    // Kept whether or not a handler catches what propagates: a failure
    // canonical execution raised is not middleware's to rescue.
    block.failure = { raised: error };
    throw error;
  }
  // The outcome the authorized terminal obtained from the settled process. A
  // chain that produced none settled nothing, so nothing is bound.
  block.outcome = result.bound;
}

/** Issue one bound command, retaining the chain the document wrote for it. */
export function issueBoundExec(
  modifiers: readonly Modifier[],
  context: CodeBlockContext,
): IssuedBoundExec {
  const block = new BoundBlock(modifiers, context);
  return {
    request: new CanonicalBoundRequest(block),
    settlement(): BoundSettlement {
      const failure = block.failure;
      if (failure !== undefined) {
        return { status: "raised", raised: failure.raised };
      }
      if (!block.consumed) {
        return {
          status: "absent",
          refusal: new BoundExecProtocolError("returned without delegating the bound command"),
        };
      }
      const outcome = block.outcome;
      if (outcome === undefined) {
        return {
          status: "raised",
          raised: new BoundExecProtocolError("returned before the command settled"),
        };
      }
      return { status: "produced", outcome };
    },
  };
}
