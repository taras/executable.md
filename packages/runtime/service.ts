/**
 * Provider-neutral attached-service lifecycle.
 *
 * The shared runtime owns the XMD service handshake shape and validation. A
 * runtime-named host adapter supplies process startup through `API.Service`
 * middleware.
 */

import { type Api, createApi, type Operations } from "@effectionx/context-api";
import type { Operation } from "effection";

export const SERVICE_READY_PREFIX = "XMD_SERVICE_READY:";
export const SERVICE_HOSTNAME = "127.0.0.1";

export interface ServiceEndpoint {
  readonly hostname: string;
  readonly port: number;
}

export interface ServiceStartOptions {
  readonly command: string;
  readonly cwd?: string;
  readonly startupTimeout?: number;
}

export interface ServiceAttachment {
  readonly endpoint: Readonly<ServiceEndpoint>;
}

export interface ServiceHandler {
  start(options: ServiceStartOptions): Operation<ServiceAttachment>;
}

export class ServiceProviderError extends Error {
  override name = "ServiceProviderError";

  constructor() {
    super(
      "attached service startup requires a host provider; install runtime.service middleware before execution",
    );
  }
}

export class ServiceProtocolMalformedError extends Error {
  override name = "ServiceProtocolMalformedError";

  constructor() {
    super("attached service emitted a malformed XMD service handshake record");
  }
}

export class ServiceProtocolIncompatibleError extends Error {
  override name = "ServiceProtocolIncompatibleError";

  constructor() {
    super("attached service emitted an incompatible XMD service handshake record");
  }
}

export class ServiceProtocolTokenMismatchError extends Error {
  override name = "ServiceProtocolTokenMismatchError";

  constructor() {
    super("XMD service handshake authentication failed");
  }
}

export class ServiceProtocolHostnameMismatchError extends Error {
  override name = "ServiceProtocolHostnameMismatchError";

  constructor() {
    super("XMD service handshake hostname is not authorized");
  }
}

export class ServiceProtocolDuplicateError extends Error {
  override name = "ServiceProtocolDuplicateError";

  constructor() {
    super("attached service emitted more than one XMD service handshake record");
  }
}

export class ServiceStartupTimeoutError extends Error {
  override name = "ServiceStartupTimeoutError";

  constructor(timeout: number) {
    super(`attached service handshake did not complete within ${timeout}ms`);
  }
}

interface ServiceExitStatus {
  readonly code?: number;
  readonly signal?: string;
}

function exitDescription(status: ServiceExitStatus): string {
  if (status.signal !== undefined) {
    return `signal ${status.signal}`;
  }
  if (status.code !== undefined) {
    return `exit code ${status.code}`;
  }
  return "an unknown exit status";
}

export class ServiceProcessExitBeforeReadyError extends Error {
  override name = "ServiceProcessExitBeforeReadyError";

  constructor(status: ServiceExitStatus) {
    super(`attached service process exited before handshake with ${exitDescription(status)}`);
  }
}

export class ServiceUnexpectedExitError extends Error {
  override name = "ServiceUnexpectedExitError";

  constructor(status: ServiceExitStatus) {
    super(`attached service process exited after handshake with ${exitDescription(status)}`);
  }
}

export class ServiceTeardownError extends Error {
  override name = "ServiceTeardownError";

  constructor(options?: { cause?: unknown }) {
    super("attached service process failed to terminate cleanly", options);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactMembers(record: Record<string, unknown>): boolean {
  const members = Object.keys(record);
  return (
    members.length === 4 &&
    members.includes("version") &&
    members.includes("token") &&
    members.includes("hostname") &&
    members.includes("port")
  );
}

/** Parse and authenticate one prefix-stripped v1 handshake payload. */
export function parseServiceReadyRecord(payload: string, expectedToken: string): ServiceEndpoint {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new ServiceProtocolMalformedError();
  }

  if (!isRecord(parsed) || !hasExactMembers(parsed)) {
    throw new ServiceProtocolMalformedError();
  }
  if (parsed.version !== 1) {
    throw new ServiceProtocolIncompatibleError();
  }
  if (typeof parsed.token !== "string" || parsed.token !== expectedToken) {
    throw new ServiceProtocolTokenMismatchError();
  }
  if (parsed.hostname !== SERVICE_HOSTNAME) {
    throw new ServiceProtocolHostnameMismatchError();
  }
  if (
    typeof parsed.port !== "number" ||
    !Number.isInteger(parsed.port) ||
    parsed.port < 1 ||
    parsed.port > 65_535
  ) {
    throw new ServiceProtocolMalformedError();
  }

  return Object.freeze({ hostname: SERVICE_HOSTNAME, port: parsed.port });
}

export const Service: Api<ServiceHandler> = createApi<ServiceHandler>("runtime.service", {
  // deno-lint-ignore require-yield
  *start(_options: ServiceStartOptions): Operation<ServiceAttachment> {
    throw new ServiceProviderError();
  },
});

export const startService: Operations<ServiceHandler>["start"] = Service.operations.start;
