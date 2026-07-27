/**
 * Tier PA — the package root's controller facade (specs/test-agent-spec.md
 * §Controller and worker). Imported through `mod.ts`, exactly as a harness
 * author gets it: what the spec calls private has to be absent at runtime, not
 * merely absent from the published types, and the scenario a harness holds is
 * still torn down with the scope that acquired it.
 */
import { describe, it } from "@effectionx/bdd/node";
import { expect } from "@effectionx/bdd/expect";
import { scoped, withResolvers } from "effection";
import type { Operation } from "effection";
import { connect } from "node:net";
import { once } from "@effectionx/node";
import * as os from "node:os";
import { useTestAgentController } from "../mod.ts";
import { parseRoute } from "../src/protocol.ts";

const DOCUMENT = { path: "behavior.md", source: '<WhenPrompt template="hi" />' };

/** Whether a TCP connection to the route's controller still succeeds. */
function* reachable(route: string): Operation<boolean> {
  const parsed = parseRoute(route);
  if (!parsed.ok) {
    throw new Error(parsed.error);
  }
  const settled = withResolvers<boolean>();
  const socket = connect({ host: parsed.message.host, port: parsed.message.port });
  socket.once("connect", () => settled.resolve(true));
  socket.once("error", () => settled.resolve(false));
  try {
    return yield* settled.operation;
  } finally {
    socket.destroy();
    yield* once(socket, "close");
  }
}

describe("Tier PA — public controller facade", () => {
  it("PA1: the controller offers useScenario and nothing else", function* () {
    const controller = yield* useTestAgentController();

    expect(Object.keys(controller)).toEqual(["useScenario"]);
    const reachedInto = controller as unknown as Record<string, unknown>;
    expect(reachedInto.probeRoute).toBe(undefined);
    expect(reachedInto.getScenarioRecord).toBe(undefined);
  });

  it("PA2: a scenario carries its route and no record state", function* () {
    const controller = yield* useTestAgentController();
    const scenario = yield* controller.useScenario({
      document: DOCUMENT,
      rootDir: os.tmpdir(),
    });

    expect(Object.keys(scenario)).toEqual(["route"]);
    expect(typeof scenario.route).toBe("string");
    const reachedInto = scenario as unknown as Record<string, unknown>;
    for (const hidden of ["id", "journal", "failure", "fatal", "rootDir", "document"]) {
      expect({ hidden, value: reachedInto[hidden] }).toEqual({ hidden, value: undefined });
    }
  });

  it("PA3: the scenario resource still ends with the scope that acquired it", function* () {
    let route = "";
    yield* scoped(function* () {
      const controller = yield* useTestAgentController();
      const scenario = yield* controller.useScenario({
        document: DOCUMENT,
        rootDir: os.tmpdir(),
      });
      route = scenario.route;
      // The facade hands back a plain handle, but the resource behind it is
      // live: its controller is serving.
      expect(yield* reachable(route)).toBe(true);
    });

    expect(yield* reachable(route)).toBe(false);
  });
});
