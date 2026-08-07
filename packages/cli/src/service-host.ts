/** Shared mechanics for the runtime-named cooperative service adapters. */

import { ensure, race, resource, withResolvers, type Operation } from "effection";
import { daemon, Stdio } from "@effectionx/process";
import { timebox } from "@effectionx/timebox";
import {
  API,
  SERVICE_HOSTNAME,
  SERVICE_READY_PREFIX,
  ServiceProcessExitBeforeReadyError,
  ServiceProtocolDuplicateError,
  ServiceProtocolMalformedError,
  ServiceStartupTimeoutError,
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

interface ProtocolObserver {
  stdout(bytes: Uint8Array): Operation<void>;
  flush(): Operation<void>;
}

const encoder = new TextEncoder();
const prefixBytes = encoder.encode(SERVICE_READY_PREFIX);

function concat(left: Uint8Array, right: Uint8Array): Uint8Array {
  const joined = new Uint8Array(left.byteLength + right.byteLength);
  joined.set(left);
  joined.set(right, left.byteLength);
  return joined;
}

function startsWithPrefix(line: Uint8Array): boolean {
  if (line.byteLength < prefixBytes.byteLength) {
    return false;
  }
  for (let index = 0; index < prefixBytes.byteLength; index += 1) {
    if (line[index] !== prefixBytes[index]) {
      return false;
    }
  }
  return true;
}

function createProtocolObserver(options: {
  token: string;
  ready(endpoint: ServiceEndpoint): void;
  fail(error: Error): void;
  forward(bytes: Uint8Array): void;
}): ProtocolObserver {
  let pending: Uint8Array = new Uint8Array();
  let readinessSeen = false;

  function consume(line: Uint8Array): void {
    if (!startsWithPrefix(line)) {
      options.forward(line);
      return;
    }
    if (readinessSeen) {
      options.fail(new ServiceProtocolDuplicateError());
      return;
    }

    let payload: string;
    try {
      payload = new TextDecoder("utf-8", { fatal: true }).decode(
        line.subarray(prefixBytes.byteLength, line.byteLength - 1),
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

  return {
    *stdout(bytes: Uint8Array): Operation<void> {
      pending = concat(pending, bytes);
      let newline = pending.indexOf(10);
      while (newline !== -1) {
        const line = pending.slice(0, newline + 1);
        pending = pending.slice(newline + 1);
        consume(line);
        newline = pending.indexOf(10);
      }
    },
    *flush(): Operation<void> {
      if (pending.byteLength > 0) {
        if (startsWithPrefix(pending)) {
          pending = new Uint8Array();
          throw new ServiceProtocolMalformedError();
        } else {
          options.forward(pending);
          pending = new Uint8Array();
        }
      }
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
    const process = yield* daemon(options.command, {
      shell: true,
      cwd: options.cwd,
      env: environment,
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
