/**
 * A raw HTTP client for the form-server tests.
 *
 * `fetch` cannot express what these tests have to say. The streaming-refusal test
 * needs to send a chunked body, *not* terminate it, and read the response while
 * still sending — `fetch` has no way to leave a request open and observe an
 * answer mid-flight. The rest need to set `Host` and `Origin`, which are
 * forbidden header names, to send a byte-identical chunked body on every runtime,
 * and to read a socket after the server has gone.
 *
 * So the tests speak HTTP/1.1 over `node:net` directly. That also means every
 * assertion is about bytes the server actually wrote, not about a runtime's
 * interpretation of them.
 */

import { action, ensure, resource, withResolvers } from "effection";
import type { Operation } from "effection";
import { connect } from "node:net";
import type { Socket } from "node:net";

export interface HttpResponse {
  status: number;
  headers: Map<string, string>;
  body: string;
  /** The raw status line, for asserting on exact bytes. */
  statusLine: string;
}

export interface HttpConnection {
  /** Send text, encoded as UTF-8. */
  write(text: string): void;
  /**
   * Send exact bytes.
   *
   * Some requests cannot be expressed as a string: a body that is deliberately
   * not valid UTF-8 has no string form that survives encoding, so the test has
   * to hand over the octets it means.
   */
  writeBytes(bytes: Uint8Array): void;
  /** The next complete response. */
  response(): Operation<HttpResponse>;
  /** Resolves when the peer closes or resets the connection. */
  ended: Operation<string>;
  /** Whether anything has been received so far. */
  receivedSoFar(): string;
}

/**
 * Connect to the form server.
 *
 * The `error` listener is not optional even though a reset is expected: an
 * unobserved `ECONNRESET` is raised as an uncaught error on Deno, so a test that
 * provokes one would fail for the wrong reason. A reset and a clean close settle
 * `ended` alike, because after a mid-stream refusal the peer may present either.
 */
export function useConnection(port: number): Operation<HttpConnection> {
  return resource(function* (provide) {
    const socket = connect(port, "127.0.0.1");
    yield* ensure(() => {
      socket.destroy();
    });

    yield* action<void>((resolve, reject) => {
      const onConnect = (): void => resolve();
      const onError = (error: Error): void => reject(error);
      socket.once("connect", onConnect);
      socket.once("error", onError);
      return () => {
        socket.removeListener("connect", onConnect);
        socket.removeListener("error", onError);
      };
    });

    let buffer = "";
    // A version counter rather than a bare callback: bytes can arrive between a
    // failed parse and the moment the waiter subscribes, and a signal delivered
    // in that window would be lost forever. Comparing versions turns the missed
    // edge into an immediate return.
    let version = 0;
    let waiting: ((value: void) => void) | undefined;
    const ended = withResolvers<string>();

    const advance = (): void => {
      version += 1;
      const notify = waiting;
      waiting = undefined;
      notify?.();
    };

    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      advance();
    });
    socket.on("error", (error: Error) => {
      ended.resolve(`error:${error.message}`);
      advance();
    });
    socket.on("close", () => {
      ended.resolve("close");
      advance();
    });

    function* untilAfter(seen: number): Operation<void> {
      if (version !== seen) {
        return;
      }
      yield* action<void>((resolve) => {
        waiting = resolve;
        return () => {
          waiting = undefined;
        };
      });
    }

    yield* provide({
      write(text: string): void {
        socket.write(new Uint8Array(new TextEncoder().encode(text)));
      },
      writeBytes(bytes: Uint8Array): void {
        socket.write(bytes);
      },
      receivedSoFar(): string {
        return buffer;
      },
      ended: ended.operation,
      *response(): Operation<HttpResponse> {
        while (true) {
          const seen = version;
          const parsed = parseResponse(buffer);
          if (parsed) {
            buffer = parsed.rest;
            return parsed.response;
          }
          yield* untilAfter(seen);
        }
      },
    });
  });
}

export interface RequestInit {
  method: string;
  path: string;
  host: string;
  headers?: Record<string, string>;
  body?: string;
}

/** One complete request, with `Content-Length` derived from the body. */
export function requestText(init: RequestInit): string {
  const headers: Record<string, string> = { Host: init.host, ...init.headers };
  const body = init.body ?? "";
  if (init.body !== undefined) {
    headers["Content-Length"] = String(new TextEncoder().encode(body).byteLength);
  }
  const lines = Object.entries(headers).map(([name, value]) => `${name}: ${value}`);
  return `${init.method} ${init.path} HTTP/1.1\r\n${lines.join("\r\n")}\r\n\r\n${body}`;
}

/**
 * One request whose body is exact bytes.
 *
 * `Content-Length` counts the octets given, not a string's length, so a body
 * that is not valid UTF-8 is framed correctly and reaches the server as sent.
 */
export function requestBytes(init: Omit<RequestInit, "body"> & { body: Uint8Array }): Uint8Array {
  const headers: Record<string, string> = {
    Host: init.host,
    ...init.headers,
    "Content-Length": String(init.body.byteLength),
  };
  const lines = Object.entries(headers).map(([name, value]) => `${name}: ${value}`);
  const head = new TextEncoder().encode(
    `${init.method} ${init.path} HTTP/1.1\r\n${lines.join("\r\n")}\r\n\r\n`,
  );
  const request = new Uint8Array(head.byteLength + init.body.byteLength);
  request.set(head, 0);
  request.set(init.body, head.byteLength);
  return request;
}

/** The head of a chunked request; the body is written chunk by chunk after it. */
export function chunkedHead(init: Omit<RequestInit, "body">): string {
  const headers: Record<string, string> = {
    Host: init.host,
    "Transfer-Encoding": "chunked",
    ...init.headers,
  };
  const lines = Object.entries(headers).map(([name, value]) => `${name}: ${value}`);
  return `${init.method} ${init.path} HTTP/1.1\r\n${lines.join("\r\n")}\r\n\r\n`;
}

export function chunk(payload: string): string {
  const size = new TextEncoder().encode(payload).byteLength;
  return `${size.toString(16)}\r\n${payload}\r\n`;
}

interface ParsedResponse {
  response: HttpResponse;
  rest: string;
}

function parseResponse(buffer: string): ParsedResponse | undefined {
  const headEnd = buffer.indexOf("\r\n\r\n");
  if (headEnd === -1) {
    return undefined;
  }
  const head = buffer.slice(0, headEnd);
  const [statusLine, ...headerLines] = head.split("\r\n");
  const status = Number(statusLine.split(" ")[1]);

  const headers = new Map<string, string>();
  for (const line of headerLines) {
    const colon = line.indexOf(":");
    if (colon > 0) {
      headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
    }
  }

  const afterHead = buffer.slice(headEnd + 4);
  const declared = headers.get("content-length");
  const length = declared === undefined ? 0 : Number(declared);
  if (afterHead.length < length) {
    return undefined;
  }

  return {
    response: { status, statusLine, headers, body: afterHead.slice(0, length) },
    rest: afterHead.slice(length),
  };
}
