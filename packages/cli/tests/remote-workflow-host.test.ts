/**
 * Tier WRH14 — the configured remote host, as trusted code constructs it.
 *
 * What this file is about is the assembly and its boundaries: that the host has
 * the same four methods the local one has and nothing more, that it is bound to
 * one run and refuses another before a token is minted or anything is sent,
 * that the two request planes take no acquisition while execution takes one,
 * and that a storage handle it did not open cannot be attached to a document.
 *
 * Everything here goes through the published entrypoints and a transport this
 * test owns. Nothing imports a provider-private module, and the owner is
 * scripted rather than real — what a real Durable Object does with these
 * requests is proved against one in
 * `packages/workflow/tests/cloudflare/remote-owner-routes.vitest.ts`, because
 * hibernation, an actual upgrade and a real transaction are not things a script
 * can claim.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, type Operation, resource, scoped } from "effection";
import { WorkflowInputDelivery, WorkflowLifecycle } from "@executablemd/workflow";
import type { WorkflowRunDatabase } from "@executablemd/workflow";
import type {
  OwnerHttpRequest,
  OwnerHttpResponse,
  OwnerSocket,
  OwnerTransport,
  OwnerUpgrade,
  OwnerUpgradeRefused,
  SocketListener,
} from "@executablemd/workflow/deno";
import { OwnerEndpointError } from "@executablemd/workflow/deno";
import { useRemoteWorkflowHost } from "../src/remote-workflow.ts";
import type { WorkflowHost } from "../src/workflow.ts";

const RUN_ID = "5cktgrv2zyutngh7bbddr2tyg2b5a567cg725hu5e7u42orerxaa";
const OTHER_RUN = "4bxsfqu1yxtsmfg6aaccq1sxf1a4z456bf614gt4d6t31nqdqwzz";
const ENDPOINT = "https://owner.example/workflow";
const RELEASE = "factory-2026.09.10-abcdef";

/** Everything one scripted owner was asked, and what it answered. */
interface Scripted {
  /** Every ordinary request, in order. */
  readonly requests: OwnerHttpRequest[];
  /** Every upgrade, in order. */
  readonly upgrades: OwnerUpgrade[];
  /** Every token this client minted, in order. */
  readonly tokens: string[];
  /** Every socket handed out, and whether it is still open. */
  readonly sockets: { readonly protocols: readonly string[]; closed: boolean }[];
  readonly transport: OwnerTransport;
  token(): Operation<string>;
}

/**
 * One owner, scripted.
 *
 * `answer` decides what an ordinary request comes back as; `upgrade` decides
 * whether the executor plane hands over a socket or a refusal. Both record
 * everything, because most of what this file proves is what was *not* asked.
 */
function scripted(
  options: {
    answer?: (request: OwnerHttpRequest) => OwnerHttpResponse;
    upgrade?: string;
  } = {},
): Scripted {
  const requests: OwnerHttpRequest[] = [];
  const upgrades: OwnerUpgrade[] = [];
  const tokens: string[] = [];
  const sockets: { readonly protocols: readonly string[]; closed: boolean }[] = [];
  let minted = 0;
  return {
    requests,
    upgrades,
    tokens,
    sockets,
    // deno-lint-ignore require-yield
    *token(): Operation<string> {
      const token = `token-${(minted += 1)}`;
      tokens.push(token);
      return token;
    },
    transport: {
      // deno-lint-ignore require-yield
      *request(request: OwnerHttpRequest): Operation<OwnerHttpResponse> {
        requests.push(request);
        return (
          options.answer?.(request) ?? {
            status: 200,
            body: JSON.stringify({ outcome: "refused", refusal: "command:absent" }),
          }
        );
      },
      connect(upgrade: OwnerUpgrade): Operation<OwnerSocket | OwnerUpgradeRefused> {
        return resource(function* (provide) {
          upgrades.push(upgrade);
          if (options.upgrade !== undefined) {
            yield* provide({ refusal: options.upgrade });
            return;
          }
          const held = { protocols: upgrade.protocols, closed: false };
          sockets.push(held);
          const socket: OwnerSocket = {
            send(): void {},
            close(): void {
              held.closed = true;
            },
            addEventListener(_type: string, _listener: SocketListener): void {},
            removeEventListener(_type: string, _listener: SocketListener): void {},
          };
          yield* ensure(() => {
            held.closed = true;
          });
          yield* provide(socket);
        });
      },
    },
  };
}

/** The host, built the way trusted code builds one. */
function* host(
  owner: Scripted,
  runId: string = RUN_ID,
  endpoint: string = ENDPOINT,
): Operation<WorkflowHost> {
  return yield* useRemoteWorkflowHost({
    runId,
    endpoint,
    release: RELEASE,
    token: () => owner.token(),
    scratchRoot: "/tmp/xmd-remote-host-test",
    transport: owner.transport,
  });
}

/** What reading a handle nothing opened would do, if anything read one. */
function refuse(): never {
  throw new Error("PLANTED-FOREIGN-DATABASE-USED");
}

/** A storage handle nothing opened: shaped like one, and one nothing may use. */
function foreignDatabase(): WorkflowRunDatabase {
  return {
    get record() {
      return refuse();
    },
    get retrieval() {
      return refuse();
    },
    get journal() {
      return refuse();
    },
    readJournalEntries: refuse,
    transact: refuse,
    replaceRetrievalMetadata: refuse,
    readDocumentExecutions: refuse,
  };
}

describe("the configured remote workflow host", () => {
  it("has the four methods a host has, and no others", function* () {
    const owner = scripted();
    const assembled = yield* scoped(function* () {
      const built = yield* host(owner);
      return Object.keys(built).toSorted();
    });
    expect(assembled).toEqual(["attach", "useDelivery", "useLifecycle", "useRunHost"]);
    // Constructing a host reaches no owner: no token was minted, no request was
    // sent and nothing was upgraded.
    expect(owner.tokens).toEqual([]);
    expect(owner.requests).toEqual([]);
    expect(owner.upgrades).toEqual([]);
  });

  it("refuses an endpoint that cannot address an owner, before anything else", function* () {
    const owner = scripted();
    const refused: Record<string, string> = {};
    const offered: Record<string, string> = {
      "endpoint-absent": "",
      "endpoint-unparseable": "not a url",
      "endpoint-scheme": "ftp://owner.example",
      "endpoint-credentials": "https://user:secret@owner.example",
      "endpoint-query": "https://owner.example/workflow?token=x",
      "endpoint-fragment": "https://owner.example/workflow#fragment",
    };
    for (const [expected, endpoint] of Object.entries(offered)) {
      refused[expected] = yield* scoped(function* () {
        try {
          // Parsed by the client's own construction, which building the host
          // reaches before it installs anything at all.
          yield* host(owner, RUN_ID, endpoint);
          return "admitted";
        } catch (error) {
          return error instanceof OwnerEndpointError ? error.refusal : "other";
        }
      });
    }
    expect(refused).toEqual(Object.fromEntries(Object.keys(offered).map((key) => [key, key])));
    // Every one of them refused here, and none of them minted a token.
    expect(owner.tokens).toEqual([]);
    expect(owner.requests).toEqual([]);
  });

  it("reads through the request plane, taking no acquisition", function* () {
    const owner = scripted();
    const outcome = yield* scoped(function* () {
      const built = yield* host(owner);
      yield* built.useLifecycle();
      const inspected = yield* WorkflowLifecycle.operations.inspect(RUN_ID);
      return inspected.ok ? "answered" : inspected.error.name;
    });
    // The owner answered `absent`, which is a fact about the run rather than a
    // failure of the plane.
    expect(outcome).toBe("WorkflowRunNotFoundError");
    // One ordinary request, on the read path of the configured endpoint, with
    // one freshly minted token beside the body rather than inside it.
    expect(owner.requests).toHaveLength(1);
    expect(owner.requests[0]?.url).toBe(`${ENDPOINT}/runs/${RUN_ID}/read`);
    expect(owner.requests[0]?.headers["authorization"]).toBe("Bearer token-1");
    expect(owner.requests[0]?.body).not.toContain("token-1");
    // And nothing was acquired to answer it.
    expect(owner.upgrades).toEqual([]);
    expect(owner.sockets).toEqual([]);
  });

  it("delivers through its own request plane, taking no acquisition", function* () {
    const owner = scripted({
      answer: () => ({
        status: 200,
        body: JSON.stringify({ outcome: "refused", refusal: "command:not-suspended" }),
      }),
    });
    const outcome = yield* scoped(function* () {
      const built = yield* host(owner);
      yield* built.useDelivery();
      const delivered = yield* WorkflowInputDelivery.operations.deliver({
        runId: RUN_ID,
        suspensionId: "suspension-1",
        value: "answered",
        secretDetection: false,
      });
      return delivered.ok ? "retained" : "refused";
    });
    expect(outcome).toBe("refused");
    expect(owner.requests).toHaveLength(1);
    expect(owner.requests[0]?.url).toBe(`${ENDPOINT}/runs/${RUN_ID}/delivery`);
    expect(owner.upgrades).toEqual([]);
  });

  it("is bound to one run, and refuses another before minting a token", function* () {
    const owner = scripted();
    const outcomes = yield* scoped(function* () {
      const built = yield* host(owner);
      yield* built.useLifecycle();
      yield* built.useDelivery();
      const inspected = yield* WorkflowLifecycle.operations.inspect(OTHER_RUN);
      const delivered = yield* WorkflowInputDelivery.operations.deliver({
        runId: OTHER_RUN,
        suspensionId: "suspension-1",
        value: "answered",
        secretDetection: false,
      });
      return {
        inspected: inspected.ok ? "answered" : inspected.error.message,
        delivered: delivered.ok ? "retained" : "refused",
      };
    });
    // Refused because this owner's plane is one run's, whichever layer says so
    // first — and said without a token having been minted for it.
    expect(outcomes.inspected).toContain("other than");
    expect(outcomes.delivered).toBe("refused");
    // The refusal happened here: no token was minted, and nothing was sent.
    expect(owner.tokens).toEqual([]);
    expect(owner.requests).toEqual([]);
    expect(owner.upgrades).toEqual([]);
  });

  it("acquires one socket for execution, and gives it up with its scope", function* () {
    const owner = scripted();
    const acquired = yield* scoped(function* () {
      const built = yield* host(owner);
      yield* built.useRunHost();
      const taken = yield* WorkflowLifecycle.operations.acquireExecutor(RUN_ID);
      return taken.ok ? taken.value.kind : `failed:${taken.error.message}`;
    });
    expect(acquired).toBe("acquired");
    // One upgrade, on the executor path, offering this build's protocol with
    // the release and a fresh token beside it — and the URL carries neither.
    expect(owner.upgrades).toHaveLength(1);
    expect(owner.upgrades[0]?.url).toBe(`${ENDPOINT}/runs/${RUN_ID}/executor`);
    expect(owner.upgrades[0]?.url).not.toContain("token");
    expect(owner.upgrades[0]?.protocols).toEqual([
      "executablemd.workflow.owner.v1",
      RELEASE,
      "token-1",
    ]);
    // No ordinary request was needed to execute, and the socket is closed now
    // that the scope that acquired it has ended.
    expect(owner.requests).toEqual([]);
    expect(owner.sockets).toHaveLength(1);
    expect(owner.sockets[0]?.closed).toBe(true);
  });

  it("reports a run another executor holds, rather than failing", function* () {
    const owner = scripted({ upgrade: "acquisition:already-running" });
    const outcome = yield* scoped(function* () {
      const built = yield* host(owner);
      yield* built.useRunHost();
      const acquired = yield* WorkflowLifecycle.operations.acquireExecutor(RUN_ID);
      return acquired.ok ? acquired.value.kind : `failed:${acquired.error.message}`;
    });
    expect(outcome).toBe("already-running");
    expect(owner.sockets).toEqual([]);
  });

  it("attaches nothing it did not open", function* () {
    const owner = scripted();
    const refused = yield* scoped(function* () {
      const built = yield* host(owner);
      yield* built.useRunHost();
      try {
        yield* built.attach(foreignDatabase(), never());
        return "attached";
      } catch (error) {
        return error instanceof Error ? error.message : "other";
      }
    });
    expect(refused).toContain("not opened by this remote host");
    // Refused before the handle was read at all: the planted accessors say so,
    // and no temporary tree, materialization or request happened either.
    expect(owner.requests).toEqual([]);
  });
});

/** An operation an attachment must never reach. */
// deno-lint-ignore require-yield
function* never(): Operation<void> {
  throw new Error("PLANTED-ATTACHED-OPERATION-RAN");
}
