/**
 * Tier WRH — the supported request boundary, on real workerd.
 *
 * The three planes stop being methods here and become requests. What that adds
 * is everything a script cannot claim: the namespace arithmetic that decides
 * which object answers, an actual WebSocket upgrade whose handshake a standard
 * client would accept, the admission order as a caller experiences it through a
 * status, and what a read or a delivery does while an executor is live.
 *
 * The client is the production one, configured exactly as a runner configures
 * it, with its I/O pointed at the stub instead of at a network. So what is
 * under test is the pair — this build's client against this build's owner — and
 * not either half against a fixture of the other.
 */

import { env, runInDurableObject } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { run, until, type Operation } from "effection";
import { remoteOwnerClient } from "../../src/cloudflare/configured.ts";
import type {
  OwnerHttpRequest,
  OwnerHttpResponse,
  OwnerTransport,
  OwnerUpgrade,
  OwnerUpgradeRefused,
} from "../../src/cloudflare/configured.ts";
import type { OwnerSocket, SocketListener } from "../../src/remote/client.ts";
import { ownerRoute } from "../../src/cloudflare/gateway.ts";
import { planePath, selectedProtocol } from "../../src/cloudflare/routes.ts";
import type { ExecutorObject } from "./support/executor-object.ts";
import { POLICY, RUN_ID, VALID_CLAIMS } from "./support/executor-object.ts";
import { generateKeys, signToken, type TestKeys } from "./support/tokens.ts";

/** The clock the owner is configured with, so a token's window is exact. */
const NOW = 1_800_000_000;
const ENDPOINT = "https://owner.invalid/workflow";

let keys: TestKeys;

beforeAll(async () => {
  keys = await generateKeys();
});

let unique = 0;

/**
 * One run id, so a test's owner is its own.
 *
 * The id is what selects the object, so a fresh id is a fresh owner — which is
 * also the arithmetic under test.
 */
function runOf(): string {
  unique += 1;
  return `${RUN_ID.slice(0, 40)}${unique}${Math.floor(Math.random() * 1_000_000)}`;
}

/** The object the gateway would reach for this run. */
function stubFor(runId: string) {
  return env.EXECUTOR.get(env.EXECUTOR.idFromName(runId));
}

function on<T>(
  stub: ReturnType<typeof stubFor>,
  body: (instance: ExecutorObject) => T,
): Promise<Awaited<T>> {
  return runInDurableObject(stub, body) as Promise<Awaited<T>>;
}

/** A token this owner admits. */
async function token(): Promise<string> {
  return await signToken(keys, { ...VALID_CLAIMS, iat: NOW - 10, nbf: NOW - 10, exp: NOW + 600 });
}

/**
 * The namespace, as the gateway addresses it.
 *
 * `idFromName` and `get` and nothing else: the gateway is handed exactly what
 * it needs to route, so a test cannot accidentally prove that it reached for
 * more.
 */
const namespace = {
  idFromName: (name: string) => env.EXECUTOR.idFromName(name),
  get: (id: DurableObjectId) => env.EXECUTOR.get(id),
};

/**
 * Every request one client made, and the transport that made it.
 *
 * The transport routes through the gateway, exactly as a Worker would: the
 * request is built from the client's own URL and headers, and nothing about it
 * is adjusted on the way.
 */
function transportTo(
  routed: { readonly urls: string[] },
  route: (request: Request) => Promise<Response>,
): OwnerTransport {
  return {
    *request(request: OwnerHttpRequest): Operation<OwnerHttpResponse> {
      routed.urls.push(request.url);
      const response = yield* until(
        route(
          new Request(request.url, {
            method: "POST",
            headers: request.headers,
            body: request.body,
          }),
        ),
      );
      return { status: response.status, body: yield* until(response.text()) };
    },

    *connect(upgrade: OwnerUpgrade): Operation<OwnerSocket | OwnerUpgradeRefused> {
      routed.urls.push(upgrade.url);
      const response = yield* until(
        route(
          new Request(upgrade.url, {
            headers: {
              upgrade: "websocket",
              "sec-websocket-protocol": upgrade.protocols.join(", "),
            },
          }),
        ),
      );
      const socket = response.webSocket;
      if (socket === null) {
        return { refusal: yield* until(response.text()) };
      }
      // Selected explicitly by the owner, which is what a standard client
      // requires when it offered a subprotocol at all.
      expect(response.headers.get("sec-websocket-protocol")).toBe(selectedProtocol());
      socket.accept();
      return ownerSocket(socket);
    },
  };
}

/**
 * The runtime's socket, as the client's contract sees it.
 *
 * A `WebSocket` here carries the runtime's own event types, and the client
 * needs only the data. The same adapter a runner's host supplies.
 */
function ownerSocket(socket: WebSocket): OwnerSocket {
  const listeners = new Map<SocketListener, EventListener>();
  return {
    send: (data) => socket.send(data),
    close: () => socket.close(),
    addEventListener(type, listener) {
      const forward: EventListener = (event) => {
        const data: unknown = Reflect.get(event, "data");
        listener(typeof data === "string" ? { data } : {});
      };
      listeners.set(listener, forward);
      socket.addEventListener(type, forward);
    },
    removeEventListener(type, listener) {
      const found = listeners.get(listener);
      if (found !== undefined) {
        socket.removeEventListener(type, found);
      }
    },
  };
}

/** One configured client for one owner, with the gateway in front of it. */
async function client(runId: string) {
  await on(stubFor(runId), (owner) =>
    owner.configure([{ kid: keys.kid, jwk: keys.publicJwk }], NOW),
  );
  const minted = await token();
  const routed = { urls: [] as string[] };
  return {
    routed,
    client: remoteOwnerClient({
      runId,
      endpoint: ENDPOINT,
      release: POLICY.release,
      // deno-lint-ignore require-yield
      *token(): Operation<string> {
        return minted;
      },
      transport: transportTo(routed, (request) => ownerRoute(namespace, request)),
    }),
  };
}

describe("the owner's request boundary", () => {
  it("routes one run id to one object, arithmetically", async () => {
    const runId = runOf();
    // The gateway is given the namespace and the request; which object answers
    // is `idFromName` and nothing else, so the same id answers twice and a
    // different id answers from somewhere else.
    const first = await ownerRoute(
      namespace,
      new Request(`${ENDPOINT}${planePath(runId, "read")}`),
    );
    expect(first.status).toBe(200);
    const answered = await first.json();
    // Nothing is stored under that id, and the owner says so rather than
    // creating anything.
    // No release travelled on this bare request, and that is the first thing
    // the owner asks about — before the token, and before the run.
    expect(answered).toEqual({ outcome: "refused", refusal: "release:release-absent" });

    // A path this build does not write reaches no object at all.
    expect((await ownerRoute(namespace, new Request(`${ENDPOINT}/nope`))).status).toBe(404);
    // Neither does an id that cannot address one.
    expect(
      (await ownerRoute(namespace, new Request(`${ENDPOINT}/runs/${"x".repeat(600)}/read`))).status,
    ).toBe(400);
  });

  it("upgrades the executor plane, and takes the acquisition last", async () => {
    const runId = runOf();
    const built = await client(runId);
    const outcome = await run(function* () {
      const admitted = yield* built.client.admit(runId);
      if (!admitted.ok) {
        return `failed:${admitted.error.message}`;
      }
      if (admitted.value === "already-running") {
        return "already-running";
      }
      // The connection is the acquisition, and the owner sees exactly one.
      expect(yield* until(on(stubFor(runId), (owner) => owner.holders()))).toBe(1);
      return "admitted";
    });
    expect(outcome).toBe("admitted");
    expect(built.routed.urls).toEqual([`${ENDPOINT}/runs/${runId}/executor`]);
    // The scope that admitted it has ended, so the socket has gone and the run
    // has no executor.
    expect(await on(stubFor(runId), (owner) => owner.holders())).toBe(0);
  });

  it("refuses an upgrade in the settled order, and takes nothing when it does", async () => {
    const runId = runOf();
    await on(stubFor(runId), (owner) =>
      owner.configure([{ kid: keys.kid, jwk: keys.publicJwk }], NOW),
    );
    const routed = { urls: [] as string[] };
    const transport = transportTo(routed, (request) => ownerRoute(namespace, request));

    /** One upgrade attempt with exactly these admission values. */
    async function attempt(release: string, minted: string): Promise<string> {
      return await run(function* () {
        const configured = remoteOwnerClient({
          runId,
          endpoint: ENDPOINT,
          release,
          // deno-lint-ignore require-yield
          *token(): Operation<string> {
            return minted;
          },
          transport,
        });
        const admitted = yield* configured.admit(runId);
        return admitted.ok
          ? admitted.value === "already-running"
            ? "already-running"
            : "admitted"
          : admitted.error.message;
      });
    }

    // A build this owner will not talk to is refused before the token is read,
    // which is why a deliberately unusable token refuses the connection all the
    // same — and the refusal a caller sees names neither the build nor the
    // token, because a private category is not a public contract.
    expect(await attempt("another-build", "not a token")).toContain("refused the operation");
    expect(await on(stubFor(runId), (owner) => owner.holders())).toBe(0);
    // An authenticated build with an unusable token is refused before the run
    // is named, and still takes nothing.
    expect(await attempt(POLICY.release, "not a token")).toContain("refused the operation");
    expect(await on(stubFor(runId), (owner) => owner.holders())).toBe(0);
    // And the one that passes both.
    expect(await attempt(POLICY.release, await token())).toBe("admitted");
    expect(await on(stubFor(runId), (owner) => owner.holders())).toBe(0);
  });

  it("answers a read while an executor is live, and takes no acquisition", async () => {
    const runId = runOf();
    const built = await client(runId);
    const outcome = await run(function* () {
      const admitted = yield* built.client.admit(runId);
      if (!admitted.ok || admitted.value === "already-running") {
        return "not-admitted";
      }
      expect(yield* until(on(stubFor(runId), (owner) => owner.holders()))).toBe(1);
      // The read plane, while that acquisition is held. Nothing is stored, so
      // the owner answers that the run is absent — over an ordinary request,
      // with no second acquisition and no effect on the first.
      const plane = yield* built.client.reads(runId);
      if (!plane.ok) {
        return `no-plane:${plane.error.message}`;
      }
      const inspected = yield* plane.value.inspect();
      // The acquisition is untouched by the read, whichever way the owner
      // answered it.
      expect(yield* until(on(stubFor(runId), (owner) => owner.holders()))).toBe(1);
      return inspected.ok ? "answered" : "refused";
    });
    // Nothing is stored, so the owner refuses rather than inventing a run.
    expect(outcome).toBe("refused");
    expect(built.routed.urls).toEqual([
      `${ENDPOINT}/runs/${runId}/executor`,
      `${ENDPOINT}/runs/${runId}/read`,
    ]);
    expect(await on(stubFor(runId), (owner) => owner.holders())).toBe(0);
  });

  it("retains a delivered value over its own request, taking no acquisition", async () => {
    const runId = runOf();
    const built = await client(runId);
    const outcome = await run(function* () {
      // Nothing is stored, so this run is not waiting for anything — which is
      // the owner's answer rather than a failure of the plane, and it is
      // reached without an acquisition existing at any point.
      const retained = yield* built.client.delivery.retain({
        runId,
        suspensionId: "suspension-1",
        answer: "answered",
        secretDetection: false,
      });
      return retained.ok ? "retained" : retained.error.name;
    });
    expect(outcome).not.toBe("retained");
    expect(built.routed.urls).toEqual([`${ENDPOINT}/runs/${runId}/delivery`]);
    expect(await on(stubFor(runId), (owner) => owner.holders())).toBe(0);
  });
});
