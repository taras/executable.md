/**
 * Gates, for suites that need ordering evidence rather than elapsed time.
 *
 * A grid that converged too early and one that converged on time take the same
 * wall clock, so nothing here measures duration. A gate is opened by something
 * that happened, and a row that waits on one either gets the event it named or
 * hangs — which is a failure the suite can see, not a pass it cannot trust.
 */

import { withResolvers } from "effection";
import type { Operation } from "effection";

export interface Gate {
  /** Settles once the gate has been opened, however long ago. */
  readonly opened: Operation<void>;
  /** Open it. Opening a gate twice is opening it once. */
  open(): void;
  /** Whether it has been opened. */
  readonly isOpen: boolean;
}

export function gate(): Gate {
  const resolvers = withResolvers<void>();
  let open = false;
  return {
    opened: resolvers.operation,
    open() {
      if (open) {
        return;
      }
      open = true;
      resolvers.resolve();
    },
    get isOpen() {
      return open;
    },
  };
}

/**
 * A gate that opens once `expected` things have arrived.
 *
 * Written for the rows that prove concurrency: several cells each announce
 * that they are inside their interactive work, and the gate opens only when
 * all of them are inside at the same time. Cells that contended could never
 * open it.
 */
export interface Barrier extends Gate {
  /** Announce one arrival. */
  arrive(): void;
  /** How many have arrived. */
  readonly arrived: number;
}

export function barrier(expected: number): Barrier {
  const inner = gate();
  let arrived = 0;
  if (expected <= 0) {
    inner.open();
  }
  return {
    opened: inner.opened,
    open: inner.open,
    get isOpen() {
      return inner.isOpen;
    },
    arrive() {
      arrived += 1;
      if (arrived >= expected) {
        inner.open();
      }
    },
    get arrived() {
      return arrived;
    },
  };
}
