import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";

import { ConfigError, parseConfig } from "../client/config.ts";
import {
  ACCEPTED_MESSAGE,
  ALREADY_SUBMITTED_MESSAGE,
  INVALID_MESSAGE,
  outcomeFor,
  TRANSPORT_MESSAGE,
} from "../client/outcome.ts";

describe("client: reading the configuration", () => {
  it("accepts the shape the server sends", function* () {
    expect(parseConfig(JSON.stringify({ bodyHtml: "<h1>Review</h1>" }))).toEqual({
      bodyHtml: "<h1>Review</h1>",
    });
    expect(parseConfig(JSON.stringify({ bodyHtml: "" }))).toEqual({ bodyHtml: "" });
  });

  it("refuses anything else", function* () {
    const refused: Array<[string, string]> = [
      ["not JSON", "{ not json"],
      ["an array", "[]"],
      ["a string", '"text"'],
      ["null", "null"],
      ["a number", "7"],
      ["no bodyHtml", JSON.stringify({ other: 1 })],
      ["a non-string bodyHtml", JSON.stringify({ bodyHtml: 7 })],
      ["a null bodyHtml", JSON.stringify({ bodyHtml: null })],
      ["an object bodyHtml", JSON.stringify({ bodyHtml: { html: "x" } })],
    ];

    for (const [label, text] of refused) {
      let raised: Error | undefined;
      try {
        parseConfig(text);
      } catch (error) {
        raised = error instanceof Error ? error : new Error(String(error));
      }
      expect({ label, name: raised?.name }).toEqual({ label, name: "ConfigError" });
      expect(raised).toBeInstanceOf(ConfigError);
    }
  });

  /**
   * The page checks its own server's answer because the value flows into the
   * DOM. A payload carrying extra fields is still usable — only `bodyHtml` is
   * ever read — but nothing beyond it is carried forward.
   */
  it("reads bodyHtml and nothing else", function* () {
    const config = parseConfig(
      JSON.stringify({ bodyHtml: "<p>ok</p>", schema: { type: "object" } }),
    );

    expect(Object.keys(config)).toEqual(["bodyHtml"]);
  });
});

describe("client: what a person is told after submitting", () => {
  it("treats 204 as done and closable", function* () {
    expect(outcomeFor(204)).toEqual({
      kind: "accepted",
      message: ACCEPTED_MESSAGE,
      formUsable: false,
      closable: true,
    });
  });

  it("treats 409 as already answered, and not retryable", function* () {
    expect(outcomeFor(409)).toEqual({
      kind: "already-submitted",
      message: ALREADY_SUBMITTED_MESSAGE,
      formUsable: false,
      closable: true,
    });
  });

  it("keeps the form usable when the server rejected the data", function* () {
    expect(outcomeFor(422)).toEqual({
      kind: "retryable",
      message: INVALID_MESSAGE,
      formUsable: true,
      closable: false,
    });
  });

  /**
   * Status 0 is how `request.ts` reports a request that never completed. Every
   * unrecognized status keeps the person's answer on screen: none of them is a
   * reason to take it away.
   */
  it("keeps the form usable for a transport failure and every other status", function* () {
    for (const status of [0, 403, 413, 415, 500, 502]) {
      expect({ status, ...outcomeFor(status) }).toEqual({
        status,
        kind: "retryable",
        message: TRANSPORT_MESSAGE,
        formUsable: true,
        closable: false,
      });
    }
  });

  it("never closes a tab whose form is still usable", function* () {
    for (const status of [0, 204, 403, 409, 413, 415, 422, 500]) {
      const outcome = outcomeFor(status);

      expect({ status, both: outcome.closable && outcome.formUsable }).toEqual({
        status,
        both: false,
      });
    }
  });
});
