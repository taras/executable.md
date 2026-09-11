/**
 * One configured client for one run's owner.
 *
 * This is the supported way a trusted runner reaches a deployment: an
 * already-selected run id, one credential-free endpoint, the exact release this
 * build talks to, and an operation that mints a short-lived token when a plane
 * needs one. Nothing here reads a flag, an environment variable, a document
 * prop or a global; a caller that has not been given these values cannot
 * construct one, which is the point.
 *
 * It is bound to one run. Every plane requires the configured id before a token
 * is minted, before a URL is built and before any I/O happens, so a client
 * cannot be walked across a namespace and there is nothing here that could
 * enumerate one.
 *
 * The three planes are three requests, not three protocols this publishes. What
 * crosses on each of them — the paths, the header names, the private commands
 * and the refusal spellings — stays inside this adapter, and the endpoint,
 * release and token stay in its closure: no workflow record, journal event,
 * public error or document-visible value carries any of them.
 */

import { Err, Ok, type Operation, type Result } from "effection";
import type { RemoteExecutorConnection } from "../remote/lifecycle-link.ts";
import type { OwnerSocket } from "../remote/client.ts";
import type { RemoteDeliveryLink } from "../remote/answer-link.ts";
import type { RemoteReadPlane } from "../remote/read.ts";
import { WorkflowRequestError } from "../storage/errors.ts";
import { cloudflareDeliveryLink } from "./delivery-client.ts";
import { cloudflareReadPlane } from "./read-client.ts";
import { useExecutorConnection } from "./executor-connection.ts";
import { parseOwnerEndpoint, type OwnerEndpoint } from "./endpoint.ts";
import { admitRunId } from "./routing.ts";
import { storageFailure } from "./client.ts";
import { RELEASE_HEADER, upgradeProtocols } from "./routes.ts";

/** One ordinary request to an owner, as a host performs it. */
export interface OwnerHttpRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/** What an owner answered an ordinary request with. */
export interface OwnerHttpResponse {
  readonly status: number;
  readonly body: string;
}

/** One upgrade request, as a host performs it. */
export interface OwnerUpgrade {
  readonly url: string;
  /** The subprotocols to offer, in the order this build offers them. */
  readonly protocols: readonly string[];
}

/** An upgrade the owner refused, with the category it refused under. */
export interface OwnerUpgradeRefused {
  readonly refusal: string;
}

/**
 * The I/O a host performs on this client's behalf.
 *
 * Explicit because performing it is the one thing a runtime has to supply and
 * this package will not reach for: `fetch` and `WebSocket` are the runner's,
 * named where the runner is assembled. Nothing here decides anything about a
 * run — a transport that answered on its own would be an owner.
 */
export interface OwnerTransport {
  /** Perform one request and answer with what came back. */
  request(request: OwnerHttpRequest): Operation<OwnerHttpResponse>;
  /**
   * Open one socket, or answer with the category the owner refused under.
   *
   * The socket must be open when this returns: the first command goes out
   * immediately, and a client that sent into a connecting socket would lose it.
   * The returned socket belongs to the calling scope.
   */
  connect(upgrade: OwnerUpgrade): Operation<OwnerSocket | OwnerUpgradeRefused>;
}

/** What a trusted host supplies to reach one run's owner. */
export interface RemoteOwnerConfiguration {
  /** The run this client is bound to. Selected by the caller, never derived. */
  readonly runId: string;
  /** Where this deployment's owners are. Credential-free, and parsed once. */
  readonly endpoint: string;
  /** The exact immutable release identity both sides must agree on. */
  readonly release: string;
  /** A fresh short-lived token for the immediate request, minted per request. */
  token(): Operation<string>;
  /** The HTTP and WebSocket I/O this client performs through. */
  readonly transport: OwnerTransport;
}

/** One run's owner, reached over its three planes. */
export interface RemoteOwnerClient {
  /** The run this client is bound to, as it was configured. */
  readonly runId: string;
  /**
   * Admit one executor connection for this run, owned by the calling scope.
   *
   * `already-running` is the owner's answer that another live executor holds
   * the run — a fact about the run rather than a failure of this call.
   */
  admit(runId: string): Operation<Result<RemoteExecutorConnection | "already-running">>;
  /** The no-acquisition read plane for this run. */
  reads(runId: string): Operation<Result<RemoteReadPlane>>;
  /** The no-acquisition delivery plane for this run. */
  readonly delivery: RemoteDeliveryLink;
}

/** The one upgrade refusal that is a fact about the run rather than about the connection. */
const ALREADY_RUNNING = "acquisition:already-running";

/** What a caller is told when it addresses a run this client is not bound to. */
function foreign(runId: string, bound: string): Error {
  // Neither id is quoted. What went wrong is that a client bound to one run was
  // asked about another, and a diagnostic naming them would put a caller's own
  // addressing mistake into a message this run may keep.
  return new WorkflowRequestError(
    runId === bound
      ? "this workflow run id cannot address a workflow owner."
      : "this client is bound to one workflow run and was asked about another.",
  );
}

/**
 * Build one client for one run.
 *
 * The endpoint is parsed here, so an operator learns about a credential, a
 * fragment, a query or a scheme this build does not speak before a token is
 * minted or anything is opened.
 */
export function remoteOwnerClient(configuration: RemoteOwnerConfiguration): RemoteOwnerClient {
  const bound = admitRunId(configuration.runId);
  const endpoint: OwnerEndpoint = parseOwnerEndpoint(configuration.endpoint);
  const { release, transport } = configuration;

  /** Hold every plane to the one run this client was configured for. */
  function admitted(runId: string): boolean {
    return runId === bound;
  }

  /**
   * Carry one plane's request, with the admission that plane already built.
   *
   * The token comes from the caller rather than from here: a plane mints one
   * for the request it is about to make, and minting a second would be two
   * credentials for one question.
   */
  function* post(
    admission: { readonly release: string; readonly token: string; readonly runId: string },
    plane: "read" | "delivery",
    body: string,
  ): Operation<string> {
    // The bound run decides before anything is built or sent.
    if (!admitted(admission.runId)) {
      throw foreign(admission.runId, bound);
    }
    const answered = yield* transport.request({
      url: endpoint.planeUrl(admission.runId, plane),
      headers: {
        [RELEASE_HEADER]: admission.release,
        authorization: `Bearer ${admission.token}`,
        "content-type": "application/json",
      },
      body,
    });
    if (answered.status !== 200) {
      // The owner answers both request planes with an envelope, so any other
      // status is the request never having reached one. Nothing about the
      // response travels: a status is not a refusal category.
      throw storageFailure("command:unavailable");
    }
    return answered.body;
  }

  return {
    runId: bound,

    *admit(runId: string): Operation<Result<RemoteExecutorConnection | "already-running">> {
      if (!admitted(runId)) {
        return Err(foreign(runId, bound));
      }
      return yield* useExecutorConnection(
        {
          *open(forRun: string): Operation<Result<OwnerSocket | "already-running">> {
            if (!admitted(forRun)) {
              return Err(foreign(forRun, bound));
            }
            const token = yield* configuration.token();
            const opened = yield* transport.connect({
              url: endpoint.planeUrl(forRun, "executor"),
              protocols: upgradeProtocols(release, token),
            });
            if (!("refusal" in opened)) {
              return Ok(opened);
            }
            // The owner refused the connection. One category is a fact about
            // the run and is reported as one; every other refusal an admission
            // can produce — a release, a token, a run id — is this connection
            // not being admitted, and the word for it stays here rather than
            // becoming a public compatibility surface.
            return opened.refusal === ALREADY_RUNNING
              ? Ok("already-running")
              : Err(storageFailure("command:unavailable"));
          },
          ids: () => {
            let command = 0;
            return () => `command-${(command += 1)}`;
          },
        },
        runId,
      );
    },

    // deno-lint-ignore require-yield
    *reads(runId: string): Operation<Result<RemoteReadPlane>> {
      if (!admitted(runId)) {
        return Err(foreign(runId, bound));
      }
      return Ok(
        cloudflareReadPlane(
          { send: (admission, body) => post(admission, "read", body) },
          release,
          configuration.token,
          runId,
        ),
      );
    },

    delivery: cloudflareDeliveryLink(
      { send: (admission, body) => post(admission, "delivery", body) },
      {
        release,
        // The delivery plane is told which run each request is for, so the
        // binding is checked here — before a token exists for a run this
        // client was never configured to answer for.
        *token(runId: string): Operation<string> {
          if (!admitted(runId)) {
            throw foreign(runId, bound);
          }
          return yield* configuration.token();
        },
      },
    ),
  };
}
