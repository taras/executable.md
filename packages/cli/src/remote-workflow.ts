/**
 * The remote workflow host — one run, one owner, assembled explicitly.
 *
 * The local host is chosen by which entrypoint is running. This one is not
 * chosen at all: it is constructed by trusted code that already holds the four
 * things it needs — which run, which owner endpoint, which release both sides
 * agreed on, and how to mint a short-lived token — and hands them in. There is
 * no flag, no environment variable, no prop and no runtime detection that
 * reaches it, because a host that could be selected by ambient configuration
 * would be a host somebody could redirect.
 *
 * What it returns is the same `WorkflowHost` the Deno host implements, with the
 * same four methods. `xmd workflow` asks them the same questions in the same
 * order; the answers come from a Durable Object instead of a file.
 *
 * The I/O adapters are here because here is where a runtime may be named. The
 * workflow package performs no `fetch` and constructs no `WebSocket` of its
 * own — it is handed both, so a test supplies deterministic transports and
 * proves the same assembly.
 */

import { ensure, resource, until, type Operation } from "effection";
import { remoteOwnerClient, useRemoteWorkflowRunner } from "@executablemd/workflow/deno";
import type { WorkflowWorkspaceOptions } from "@executablemd/workflow/deno";
import type {
  OwnerHttpRequest,
  OwnerHttpResponse,
  OwnerSocket,
  OwnerTransport,
  OwnerUpgrade,
  OwnerUpgradeRefused,
} from "@executablemd/workflow/deno";
import type { WorkflowExecutionTransitions, WorkflowRunDatabase } from "@executablemd/workflow";
import type { WorkflowHost } from "./workflow.ts";

/** What trusted code supplies to reach one run on one owner. */
export interface RemoteWorkflowConfiguration {
  /** The already-selected public run id. Never derived here. */
  readonly runId: string;
  /** The credential-free owner endpoint, parsed once when this is built. */
  readonly endpoint: string;
  /** The exact immutable release identity this deployment admits. */
  readonly release: string;
  /** A fresh short-lived token for the immediate request. */
  token(): Operation<string>;
  /**
   * Where this runner assembles fork candidates.
   *
   * Runner-local scratch, and nothing durable lives in it. Explicit for the
   * same reason everything else here is: a directory read from the environment
   * is a directory somebody else can choose.
   */
  readonly scratchRoot: string;
  /**
   * The HTTP and WebSocket I/O to perform, when the platform's own will not do.
   *
   * Absent means this runtime's `fetch` and `WebSocket`, which is what a real
   * runner uses. A test supplies its own and proves the same assembly against a
   * transport it controls.
   */
  readonly transport?: OwnerTransport;
  /**
   * What a live or partial attachment installs beyond the run's own Workspace.
   *
   * The host-owned inputs and only those: which issue tracker this program
   * authorizes, which pull requests a document may read, how this host
   * assembles its credential helper, and which Agent profile it installs.
   * There is no member for a substituted repository host, a Git-host transport
   * or an invocation observer, because each of those is a seam through which a
   * credential this run acquires would become visible to whoever supplied it.
   *
   * Explicit, like everything else here. Nothing is read from a flag, an
   * environment variable, a document prop or a global, and an absent member
   * keeps the capability's unconfigured behavior.
   */
  readonly capabilities?: WorkflowWorkspaceOptions;
}

/**
 * Assemble one remote host for one run.
 *
 * Everything it installs belongs to the calling scope: the executor connection
 * an execution acquires, the read and delivery planes, the temporary trees a
 * Workspace mutation materializes into, and the storage handles opened along
 * the way all end when that scope does.
 */
export function* useRemoteWorkflowHost(
  configuration: RemoteWorkflowConfiguration,
): Operation<WorkflowHost> {
  const client = remoteOwnerClient({
    runId: configuration.runId,
    endpoint: configuration.endpoint,
    release: configuration.release,
    token: () => configuration.token(),
    transport: configuration.transport ?? platformTransport(),
  });
  const runner = yield* useRemoteWorkflowRunner({
    owner: client,
    scratchRoot: configuration.scratchRoot,
    // Projected member by member, as the published boundary is everywhere
    // else: a spread would carry whatever else a caller put on the object.
    ...(configuration.capabilities === undefined
      ? {}
      : { capabilities: permitted(configuration.capabilities) }),
  });
  return {
    useRunHost(): Operation<WorkflowExecutionTransitions> {
      return runner.useRunHost();
    },
    useLifecycle(): Operation<void> {
      return runner.useLifecycle();
    },
    useDelivery(): Operation<void> {
      return runner.useDelivery();
    },
    attach<T>(database: WorkflowRunDatabase, operation: Operation<T>): Operation<T> {
      // Only the exact handle this host's own lifecycle opened is attachable,
      // and the runner proves that by identity rather than by comparing what
      // the handle says about itself.
      return runner.attach(database, operation);
    },
  };
}

/** The two pieces of I/O this runtime already has, named once. */
function platformTransport(): OwnerTransport {
  return {
    *request(request: OwnerHttpRequest): Operation<OwnerHttpResponse> {
      const response = yield* until(
        fetch(request.url, {
          method: "POST",
          headers: { ...request.headers },
          body: request.body,
        }),
      );
      // Read to completion here, so nothing downstream holds a body that has
      // to be drained or cancelled.
      return { status: response.status, body: yield* until(response.text()) };
    },

    connect(upgrade: OwnerUpgrade): Operation<OwnerSocket | OwnerUpgradeRefused> {
      return resource(function* (provide) {
        const socket = new WebSocket(upgrade.url, [...upgrade.protocols]);
        // The socket belongs to this scope from the moment it exists, so a
        // cancellation between opening and handing it over still closes it.
        yield* ensure(() => {
          socket.close();
        });
        const settled = new Promise<OwnerSocket | OwnerUpgradeRefused>((resolve) => {
          socket.addEventListener("open", () => resolve(socket), { once: true });
          // A refused upgrade closes without ever opening. The owner answered a
          // status and a category, and a standard client is shown neither, so
          // what travels is that the owner could not be reached for this
          // request — its own vocabulary reaches the planes that can carry it.
          const refused = () => resolve({ refusal: "command:unavailable" });
          socket.addEventListener("error", refused, { once: true });
          socket.addEventListener("close", refused, { once: true });
        });
        yield* provide(yield* until(settled));
      });
    },
  };
}

/**
 * The capability inputs this host passes on, and the whole of them.
 *
 * Named one at a time rather than forwarded: what a trusted caller may
 * configure is a closed list, and reading a property nobody declared is how a
 * getter somebody else wrote gets to run.
 */
function permitted(options: WorkflowWorkspaceOptions): WorkflowWorkspaceOptions {
  return {
    ...(options.gitHubIssues === undefined ? {} : { gitHubIssues: options.gitHubIssues }),
    ...(options.gitHubPullRequests === undefined
      ? {}
      : {
          gitHubPullRequests: {
            ...(options.gitHubPullRequests.allowed === undefined
              ? {}
              : { allowed: options.gitHubPullRequests.allowed }),
            ...(options.gitHubPullRequests.endpoint === undefined
              ? {}
              : { endpoint: options.gitHubPullRequests.endpoint }),
          },
        }),
    ...(options.helper === undefined ? {} : { helper: options.helper }),
    ...(options.agent === undefined ? {} : { agent: options.agent }),
  };
}
