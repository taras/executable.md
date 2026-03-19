/**
 * findFreePort — find an available TCP port using the OS.
 */

import { race } from "effection";
import type { Operation } from "effection";
import { once } from "@effectionx/node";
import { createServer } from "node:net";

/**
 * Find an available TCP port by binding to port 0 and reading the
 * OS-assigned port number.
 */
export function* findFreePort(): Operation<number> {
  const server = createServer();

  const listening = once(server, "listening");
  const error = once<[Error]>(server, "error");

  server.listen(0);

  try {
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
