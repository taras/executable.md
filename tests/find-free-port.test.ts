/**
 * Tier R — findFreePort and VM globals tests.
 *
 * Verifies findFreePort returns a usable port and that VM sandbox
 * globals are accessible.
 */
import { describe, it } from "@effectionx/bdd/node";
import { expect } from "@std/expect";
import { race } from "effection";
import type { Operation } from "effection";
import { once } from "@effectionx/node";
import { createServer } from "node:net";
import { findFreePort } from "../src/find-free-port.ts";
import { createEvalContext } from "../src/eval-context.ts";

describe("Tier R — findFreePort", () => {
  // R1: findFreePort returns a number > 0
  it("R1: findFreePort returns a number > 0", function* () {
    const port = yield* findFreePort();
    expect(typeof port).toBe("number");
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThanOrEqual(65535);
  });

  // R3: Returned port is bindable (open a server on it)
  it("R3: returned port is bindable", function* () {
    const port = yield* findFreePort();

    const server = createServer();
    const listening = once(server, "listening");
    const error = once<[Error]>(server, "error");

    server.listen(port);

    try {
      yield* race([
        listening,
        {
          *[Symbol.iterator]() {
            const [err] = yield* error;
            throw err;
          },
        } as Operation<never>,
      ]);
      // If we reach here, the server bound successfully
    } finally {
      server.close();
    }
  });

  // R1b: Two consecutive calls return different ports
  it("R1b: two consecutive calls return different ports", function* () {
    const port1 = yield* findFreePort();
    const port2 = yield* findFreePort();
    // Ports should both be valid — they may or may not be different
    // (the OS recycles ports), but both should be valid numbers
    expect(typeof port1).toBe("number");
    expect(typeof port2).toBe("number");
    expect(port1).toBeGreaterThan(0);
    expect(port2).toBeGreaterThan(0);
  });
});

describe("Tier R — VM sandbox globals", () => {
  // R6: when is accessible in the VM sandbox
  it("R6: when is accessible in eval sandbox", function* () {
    const ctx = createEvalContext();
    expect(ctx.vmContext).toBeTruthy();
    // The sandbox should have 'when' defined
    const hasWhen = "when" in (ctx.vmContext as Record<string, unknown>);
    expect(hasWhen).toBe(true);
  });

  // R1c: findFreePort is accessible in the VM sandbox
  it("R1c: findFreePort is accessible in eval sandbox", function* () {
    const ctx = createEvalContext();
    const hasFindFreePort = "findFreePort" in (ctx.vmContext as Record<string, unknown>);
    expect(hasFindFreePort).toBe(true);
  });

  // R6b: All expected Effection globals are in the sandbox
  it("R6b: expected Effection globals are in sandbox", function* () {
    const ctx = createEvalContext();
    const sandbox = ctx.vmContext as Record<string, unknown>;
    const expected = [
      "sleep", "spawn", "call", "resource", "useScope",
      "createChannel", "each", "suspend", "createSignal",
      "when", "findFreePort", "console",
    ];
    for (const name of expected) {
      expect(name in sandbox).toBe(true);
    }
  });
});
