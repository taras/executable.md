/** Shared mechanics for the runtime-named cooperative service adapters. */

import { ensure, race, resource, scoped, withResolvers, type Operation } from "effection";
import { daemon, Stdio, type Daemon } from "@effectionx/process";
import { timebox } from "@effectionx/timebox";
import {
  API,
  SERVICE_HOSTNAME,
  SERVICE_READY_PREFIX,
  ServiceProcessExitBeforeReadyError,
  ServiceProtocolDuplicateError,
  ServiceProtocolMalformedError,
  ServiceStartupTimeoutError,
  ServiceTeardownError,
  ServiceUnexpectedExitError,
  parseServiceReadyRecord,
  timeout,
} from "@executablemd/runtime";
import type { ServiceEndpoint, ServiceResource, ServiceStartOptions } from "@executablemd/runtime";

interface HostServiceAdapter {
  token(): string;
  environment(): Record<string, string>;
  stdout(bytes: Uint8Array): void;
  stderr(bytes: Uint8Array): void;
}

export interface ProtocolObserver {
  stdout(bytes: Uint8Array): Operation<void>;
  flush(): Operation<void>;
}

const encoder = new TextEncoder();
const prefixBytes = encoder.encode(SERVICE_READY_PREFIX);
const MAX_PROTOCOL_RECORD_BYTES = 1_024;

export function createProtocolObserver(options: {
  token: string;
  ready(endpoint: ServiceEndpoint): void;
  fail(error: Error): void;
  forward(bytes: Uint8Array): void;
}): ProtocolObserver {
  let state: "prefix" | "ordinary" | "protocol" | "suppressed" = "prefix";
  let possiblePrefix: number[] = [];
  let protocolRecord: number[] = [];
  let readinessSeen = false;

  function beginLine(): void {
    state = "prefix";
    possiblePrefix = [];
    protocolRecord = [];
  }

  function consumeProtocolRecord(): void {
    if (readinessSeen) {
      options.fail(new ServiceProtocolDuplicateError());
      return;
    }

    let payload: string;
    try {
      payload = new TextDecoder("utf-8", { fatal: true }).decode(
        Uint8Array.from(protocolRecord.slice(prefixBytes.byteLength)),
      );
    } catch {
      options.fail(new ServiceProtocolMalformedError());
      return;
    }

    try {
      const endpoint = parseServiceReadyRecord(payload, options.token);
      readinessSeen = true;
      options.ready(endpoint);
    } catch (error) {
      options.fail(error instanceof Error ? error : new ServiceProtocolMalformedError());
    }
  }

  function appendProtocol(bytes: Uint8Array, start: number, end: number): boolean {
    if (protocolRecord.length + end - start > MAX_PROTOCOL_RECORD_BYTES) {
      protocolRecord = [];
      state = "suppressed";
      options.fail(new ServiceProtocolMalformedError());
      return false;
    }
    for (let index = start; index < end; index += 1) {
      protocolRecord.push(bytes[index]!);
    }
    return true;
  }

  return {
    *stdout(bytes: Uint8Array): Operation<void> {
      let index = 0;
      while (index < bytes.byteLength) {
        if (state === "prefix") {
          const byte = bytes[index]!;
          if (byte === prefixBytes[possiblePrefix.length]) {
            possiblePrefix.push(byte);
            index += 1;
            if (possiblePrefix.length === prefixBytes.byteLength) {
              protocolRecord = [...possiblePrefix];
              possiblePrefix = [];
              state = "protocol";
            }
            continue;
          }

          if (possiblePrefix.length > 0) {
            options.forward(Uint8Array.from(possiblePrefix));
            possiblePrefix = [];
          }
          state = "ordinary";
          continue;
        }

        if (state === "ordinary") {
          const newline = bytes.indexOf(10, index);
          if (newline === -1) {
            options.forward(bytes.slice(index));
            index = bytes.byteLength;
          } else {
            options.forward(bytes.slice(index, newline + 1));
            index = newline + 1;
            beginLine();
          }
          continue;
        }

        if (state === "protocol") {
          const newline = bytes.indexOf(10, index);
          const end = newline === -1 ? bytes.byteLength : newline;
          if (!appendProtocol(bytes, index, end)) {
            index = end;
            continue;
          }
          if (newline === -1) {
            index = bytes.byteLength;
          } else {
            consumeProtocolRecord();
            index = newline + 1;
            beginLine();
          }
          continue;
        }

        const newline = bytes.indexOf(10, index);
        if (newline === -1) {
          index = bytes.byteLength;
        } else {
          index = newline + 1;
          beginLine();
        }
      }
    },
    *flush(): Operation<void> {
      if (state === "prefix" && possiblePrefix.length > 0) {
        options.forward(Uint8Array.from(possiblePrefix));
      } else if (state === "protocol") {
        beginLine();
        throw new ServiceProtocolMalformedError();
      }
      beginLine();
    },
  };
}

function validTimeout(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("service startup timeout must be a positive finite number");
  }
  return value;
}

function exitFacts(status: { code?: number; signal?: string }): {
  code?: number;
  signal?: string;
} {
  return {
    ...(typeof status.code === "number" ? { code: status.code } : {}),
    ...(typeof status.signal === "string" ? { signal: status.signal } : {}),
  };
}

function* waitForStartup(options: {
  ready: Operation<ServiceEndpoint>;
  protocolFailure: Operation<never>;
  process: { join(): Operation<{ code?: number; signal?: string }> };
  observer: ProtocolObserver;
  startupTimeout: number;
}): Operation<ServiceEndpoint> {
  const result = yield* timebox(options.startupTimeout, () =>
    race([
      options.ready,
      (function* (): Operation<ServiceEndpoint> {
        const status = yield* options.process.join();
        yield* options.observer.flush();
        throw new ServiceProcessExitBeforeReadyError(exitFacts(status));
      })(),
      (function* (): Operation<ServiceEndpoint> {
        return yield* options.protocolFailure;
      })(),
    ]),
  );
  if (result.timeout) {
    throw new ServiceStartupTimeoutError(options.startupTimeout);
  }
  return result.value;
}

function serviceProcess(options: {
  command: string;
  cwd?: string;
  environment: Record<string, string>;
}): Operation<Daemon> {
  return resource(function* (provide) {
    let published = false;
    try {
      yield* scoped(function* () {
        const process = yield* daemon(options.command, {
          shell: true,
          cwd: options.cwd,
          env: options.environment,
        });
        published = true;
        yield* provide(process);
      });
    } catch (error) {
      if (!published || error instanceof ServiceTeardownError) {
        throw error;
      }
      throw new ServiceTeardownError({ cause: error });
    }
  });
}

function startHostService(
  options: ServiceStartOptions,
  adapter: HostServiceAdapter,
): Operation<ServiceResource> {
  return resource(function* (provide) {
    const token = adapter.token();
    if (!/^[0-9a-f]{64}$/.test(token)) {
      throw new Error("host service adapter returned an invalid authentication token");
    }
    const startupTimeout = validTimeout(options.startupTimeout ?? (yield* timeout));
    const ready = withResolvers<ServiceEndpoint>();
    const protocolFailure = withResolvers<never>();
    const observer = createProtocolObserver({
      token,
      ready: ready.resolve,
      fail: protocolFailure.reject,
      forward: adapter.stdout,
    });

    yield* Stdio.around({
      *stdout([bytes]) {
        yield* observer.stdout(bytes);
      },
      *stderr([bytes]) {
        adapter.stderr(bytes);
      },
    });

    yield* ensure(function* () {
      yield* observer.flush();
    });

    const environment = {
      ...adapter.environment(),
      XMD_SERVICE_PROTOCOL: "1",
      XMD_SERVICE_TOKEN: token,
      XMD_SERVICE_HOST: SERVICE_HOSTNAME,
      XMD_SERVICE_PORT: "0",
    };
    const process = yield* serviceProcess({
      command: options.command,
      cwd: options.cwd,
      environment,
    });
    const endpoint = yield* waitForStartup({
      ready: ready.operation,
      protocolFailure: protocolFailure.operation,
      process,
      observer,
      startupTimeout,
    });

    yield* race([
      provide({ endpoint }),
      (function* (): Operation<never> {
        const status = yield* process.join();
        yield* observer.flush();
        throw new ServiceUnexpectedExitError(exitFacts(status));
      })(),
      protocolFailure.operation,
    ]);
  });
}

export function installHostService(adapter: HostServiceAdapter): Operation<void> {
  return API.Service.around(
    {
      *start([options]) {
        return yield* startHostService(options, adapter);
      },
    },
    { at: "min" },
  );
}

export function inheritedEnvironment(
  source: Record<string, string | undefined>,
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined) {
      environment[name] = value;
    }
  }
  return environment;
}
