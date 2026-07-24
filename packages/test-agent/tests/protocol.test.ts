/**
 * Tier TP — controller/worker protocol tests (specs/test-agent-spec.md
 * §Controller and worker).
 */
import { describe, it } from "@effectionx/bdd/node";
import { expect } from "@effectionx/bdd/expect";
import {
  createLineSplitter,
  encodeMessage,
  formatRoute,
  parseControllerMessage,
  parseRoute,
  parseWorkerMessage,
} from "../src/protocol.ts";

describe("Tier TP — controller protocol", () => {
  it("TP1: worker messages round-trip through encode and parse", function* () {
    const line = encodeMessage({ t: "attach", token: "tok", instance: "inst" });
    const result = parseWorkerMessage(line.trimEnd());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.message).toEqual({ t: "attach", token: "tok", instance: "inst" });
    }
  });

  it("TP2: journal events are structurally validated", function* () {
    const good = parseWorkerMessage(
      JSON.stringify({
        t: "journal",
        seq: 0,
        event: {
          type: "yield",
          coroutineId: "root.0",
          description: { type: "when_prompt", name: "when:doc.md:1:1#0" },
          result: { status: "ok", value: { prompt: "hi", captures: {} } },
        },
      }),
    );
    expect(good.ok).toBe(true);
    const bad = parseWorkerMessage(
      JSON.stringify({ t: "journal", seq: 0, event: { type: "yield" } }),
    );
    expect(bad.ok).toBe(false);
  });

  it("TP3: malformed JSON and unknown message types are rejected", function* () {
    expect(parseWorkerMessage("{not json").ok).toBe(false);
    expect(parseWorkerMessage(JSON.stringify({ t: "bogus" })).ok).toBe(false);
    expect(parseControllerMessage(JSON.stringify({ t: "bogus" })).ok).toBe(false);
  });

  it("TP4: directionally invalid messages are rejected", function* () {
    const controllerLine = JSON.stringify({ t: "ack", seq: 1 });
    expect(parseControllerMessage(controllerLine).ok).toBe(true);
    expect(parseWorkerMessage(controllerLine).ok).toBe(false);

    const workerLine = JSON.stringify({ t: "fatal", message: "boom" });
    expect(parseWorkerMessage(workerLine).ok).toBe(true);
    expect(parseControllerMessage(workerLine).ok).toBe(false);
  });

  it("TP5: scenario config carries the document and journal only", function* () {
    const result = parseControllerMessage(
      JSON.stringify({
        t: "config",
        mode: "scenario",
        doc: { path: "agents/review.md", source: '<WhenPrompt template="hi" />' },
        journal: [],
      }),
    );
    expect(result.ok).toBe(true);
    const withEnv = parseControllerMessage(
      JSON.stringify({ t: "config", mode: "scenario", doc: { path: "a", source: "b" } }),
    );
    expect(withEnv.ok).toBe(false);
  });

  it("TP6: the line splitter reassembles partial chunks", function* () {
    const splitter = createLineSplitter();
    expect(splitter.feed('{"t":"ack",')).toEqual([]);
    expect(splitter.feed('"seq":1}\n{"t":"error","message":"x"}\n{"t":')).toEqual([
      '{"t":"ack","seq":1}',
      '{"t":"error","message":"x"}',
    ]);
    expect(splitter.feed('"ack","seq":2}\n')).toEqual(['{"t":"ack","seq":2}']);
  });

  it("TP7: routes round-trip and reject malformed values", function* () {
    const route = { host: "127.0.0.1", port: 4321, token: "tok-1", instance: "inst-1" };
    const parsed = parseRoute(formatRoute(route));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.message).toEqual(route);
    }
    expect(parseRoute("no-route-here").ok).toBe(false);
    expect(parseRoute("127.0.0.1:99999999/t/i").ok).toBe(false);
  });
});
