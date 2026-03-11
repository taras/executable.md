/**
 * findFreePort — find an available TCP port using the OS.
 *
 * Creates a temporary server on port 0, reads the OS-assigned port,
 * closes the server, and returns the port number. There is a small
 * race window between close and the caller binding the port — this
 * is acceptable in practice.
 *
 * Wrapped as an Effection Operation with proper cleanup: if the
 * operation is cancelled before the port is read, the server is
 * closed.
 */

import { createServer } from "node:net";
import { call } from "effection";
import type { Operation } from "effection";

/**
 * Find an available TCP port by binding to port 0 and reading the
 * OS-assigned port number.
 *
 * @returns An Operation that resolves to an available port number
 */
export function findFreePort(): Operation<number> {
  return call(function () {
    return new Promise<number>((resolve, reject) => {
      const server = createServer();
      server.unref();
      server.on("error", reject);
      server.listen(0, () => {
        const addr = server.address();
        if (addr && typeof addr === "object") {
          const port = addr.port;
          server.close((err) => {
            if (err) reject(err);
            else resolve(port);
          });
        } else {
          server.close();
          reject(new Error("findFreePort: unexpected address format"));
        }
      });
    });
  });
}
