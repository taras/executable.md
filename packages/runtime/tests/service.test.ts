import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { scoped } from "effection";
import {
  API,
  SERVICE_HOSTNAME,
  ServiceProtocolHostnameMismatchError,
  ServiceProtocolIncompatibleError,
  ServiceProtocolMalformedError,
  ServiceProtocolTokenMismatchError,
  ServiceProviderError,
  parseServiceReadyRecord,
  startService,
} from "../mod.ts";

const TOKEN = "ab".repeat(32);

function record(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 1,
    token: TOKEN,
    hostname: SERVICE_HOSTNAME,
    port: 49_152,
    ...overrides,
  });
}

describe("runtime.service", () => {
  it("fails when no provider is installed", function* () {
    let failure: unknown;
    try {
      yield* startService({ command: "server" });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ServiceProviderError);
  });

  it("accepts the exact authenticated v1 record and freezes the endpoint", function* () {
    const endpoint = parseServiceReadyRecord(record(), TOKEN);
    expect(endpoint).toEqual({ hostname: SERVICE_HOSTNAME, port: 49_152 });
    expect(Object.keys(endpoint)).toEqual(["hostname", "port"]);
    expect(Object.isFrozen(endpoint)).toBe(true);
  });

  it("rejects malformed records without retaining their input", function* () {
    const unsafe = `unsafe-${TOKEN}`;
    const malformed = [
      unsafe,
      "null",
      "[]",
      "{}",
      JSON.stringify({ version: 1, token: TOKEN, hostname: SERVICE_HOSTNAME }),
      record({ extra: unsafe }),
      record({ port: 0 }),
      record({ port: 65_536 }),
      record({ port: 1.5 }),
      record({ port: "49152" }),
    ];

    for (const candidate of malformed) {
      let failure: unknown;
      try {
        parseServiceReadyRecord(candidate, TOKEN);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(ServiceProtocolMalformedError);
      expect(String(failure)).not.toContain(TOKEN);
      expect(JSON.stringify(failure)).not.toContain(TOKEN);
      expect(String(failure)).not.toContain(candidate);
    }
  });

  it("categorizes incompatible, forged, and unauthorized records safely", function* () {
    const cases: Array<[string, new () => Error]> = [
      [record({ version: 2 }), ServiceProtocolIncompatibleError],
      [record({ token: "cd".repeat(32) }), ServiceProtocolTokenMismatchError],
      [record({ hostname: "0.0.0.0" }), ServiceProtocolHostnameMismatchError],
    ];

    for (const [candidate, ErrorType] of cases) {
      let failure: unknown;
      try {
        parseServiceReadyRecord(candidate, TOKEN);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(ErrorType);
      expect(String(failure)).not.toContain(TOKEN);
      expect(JSON.stringify(failure)).not.toContain(candidate);
    }
  });

  it("uses a scoped contextual provider without leaking it", function* () {
    const endpoint = Object.freeze({ hostname: SERVICE_HOSTNAME, port: 7001 });
    const provided = yield* scoped(function* () {
      yield* API.Service.around(
        {
          *start() {
            return { endpoint };
          },
        },
        { at: "min" },
      );
      return yield* startService({ command: "server" });
    });

    expect(provided.endpoint).toBe(endpoint);

    let failure: unknown;
    try {
      yield* startService({ command: "server" });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ServiceProviderError);
  });
});
