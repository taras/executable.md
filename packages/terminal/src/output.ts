/**
 * Where a cell's rendered Markdown goes.
 *
 * This is an integration facet, not a capability. It carries no store, no
 * dispatch, no identity, and no way to set a title or a status — the only
 * thing it can do is add to the content of the one cell whose scope issued it.
 * Outside such a scope it is inert, which is what makes a copy kept past its
 * grid, or an import reached from ordinary document work, worth nothing.
 *
 * An append waits for the private aggregate commit and not for rendering. That
 * is the whole causal claim: by the time it returns, the output is part of the
 * desired state a later `launch()` or `shell()` will converge through.
 */

import { createContext } from "effection";
import type { Context, Operation } from "effection";

/** What one issued cell scope does with rendered bytes. */
export type TerminalCellOutputSink = (text: string) => Operation<void>;

const CellOutput: Context<TerminalCellOutputSink | undefined> = createContext<
  TerminalCellOutputSink | undefined
>("terminal.cellOutput", undefined);

/**
 * Add rendered Markdown to the current cell's desired content.
 *
 * Empty text is a no-op. Every other call appends in call order, so `content`
 * remains the complete output the cell has produced so far.
 */
export function appendTerminalCellOutput(text: string): Operation<void> {
  return (function* (): Operation<void> {
    if (text.length === 0) {
      return;
    }
    const sink = yield* CellOutput.get();
    if (sink === undefined) {
      return;
    }
    yield* sink(text);
  })();
}

/** Install one cell's sink for the scope that interprets its work. */
export function* installTerminalCellOutput(sink: TerminalCellOutputSink): Operation<void> {
  yield* CellOutput.set(sink);
}
