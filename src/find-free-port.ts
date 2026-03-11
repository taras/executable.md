/**
 * findFreePort — find an available TCP port using the OS.
 *
 * Uses Effection's structured concurrency primitives:
 * - `once` from @effectionx/node for event-to-Operation bridging
 * - `race` to handle both "listening" and "error" events
 * - Generator with try/finally for guaranteed server cleanup
 *
 * If the operation is cancelled (parent scope torn down), the finally
 * block closes the server. If the server emits "error" before
 * "listening", the error propagates via race().
 */

import { race } from "effection";
import type { Operation } from "effection";
import { once } from "@effectionx/node";
import { createServer } from "node:net";

/**
 * Find an available TCP port by binding to port 0 and reading the
 * OS-assigned port number.
 *
 * Binds a server to port 0, which lets the OS assign an available
 * port. Races the "listening" event against "error" — if binding
 * fails, the error propagates immediately. The server is always
 * closed in the finally block, whether the operation completes,
 * throws, or is cancelled.
 *
 * @returns An Operation that resolves to an available port number
 */
export function* findFreePort(): Operation<number> {
  const server = createServer();

  // Wire event listeners synchronously before listen().
  // once() attaches via server.on() immediately and returns an
  // Operation backed by withResolvers that settles on first event.
  const listening = once(server, "listening");
  const error = once<[Error]>(server, "error");

  server.listen(0);

  try {
    // Race listening against error. If "error" fires first,
    // the rethrow makes race() propagate the server error.
    const rethrowError: Operation<never> = {
      *[Symbol.iterator]() {
        const [err] = yield* error;
        throw err;
      },
    } as Operation<never>;

    yield* race([listening, rethrowError]);

    const addr = server.address();
    if (!addr || typeof addr !== "object") {
      throw new Error("findFreePort: unexpected address format");
    }
    return addr.port;
  } finally {
    server.close();
  }
}
