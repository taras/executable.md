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
import type { RemoteWorkflowConfiguration } from "../src/remote-workflow.ts";
import type { WorkflowHost } from "../src/workflow.ts";
import {
  document,
  published,
  scriptedOwner,
  startingTree,
  useHostSpy,
} from "../../workflow/tests/support/remote-owner-script.ts";
import { useBareRemote } from "../../workflow/tests/support/git-remotes.ts";
import {
  agentSessionKey,
  resolveAgentSession,
  transactAgentSessions,
} from "@executablemd/workflow/deno";
import type { ProviderAssertion } from "@executablemd/workflow/deno";

const RUN_ID = "5cktgrv2zyutngh7bbddr2tyg2b5a567cg725hu5e7u42orerxaa";

/** The session this run's Agent profile is about. */
const IDENTITY = {
  provider: "acpx",
  agentCommand: "/usr/bin/claude",
  sessionIdentity: "expansion-1",
};
const POLICY = "policy-1";
const ASSERTED: ProviderAssertion = { kind: "acp", value: "conversation-1" };
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

/** The configured public host, over a scripted owner's socket. */
function hostFor(
  owner: { readonly socket: OwnerSocket },
  capabilities?: NonNullable<RemoteWorkflowConfiguration["capabilities"]>,
): Operation<WorkflowHost> {
  return useRemoteWorkflowHost({
    ...(capabilities === undefined ? {} : { capabilities }),
    runId: RUN_ID,
    endpoint: ENDPOINT,
    release: RELEASE,
    // deno-lint-ignore require-yield
    *token(): Operation<string> {
      return "token-1";
    },
    scratchRoot: "/tmp/xmd-remote-public-host",
    transport: {
      // deno-lint-ignore require-yield
      *request(): Operation<OwnerHttpResponse> {
        throw new Error("PLANTED-REQUEST-PLANE-REACHED");
      },
      connect(): Operation<OwnerSocket> {
        return resource(function* (provide) {
          yield* provide(owner.socket);
        });
      },
    },
  });
}

/** One authored document, executed as this run's root. */
function documentOf(source: string, database: WorkflowRunDatabase): Operation<unknown> {
  return document(source, database);
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

/**
 * What a caller may configure, at the type level.
 *
 * The published boundary excludes a substituted repository host, a Git-host
 * transport and an invocation observer, because each is a seam through which a
 * credential this run acquires would become visible to whoever supplied it.
 * That exclusion is a property of the *type*, so this is where it is asserted:
 * adding `composition` back to what the public configuration accepts stops this
 * file compiling.
 */
type Capabilities = NonNullable<RemoteWorkflowConfiguration["capabilities"]>;
type NoComposition = "composition" extends keyof Capabilities ? never : true;
type NoObserver = "observe" extends keyof Capabilities ? never : true;
type NoAccess = "access" extends keyof NonNullable<Capabilities["gitHubPullRequests"]>
  ? never
  : true;
const NARROW: [NoComposition, NoObserver, NoAccess] = [true, true, true];

describe("the configured remote workflow host", () => {
  it("has the four methods a host has, and no others", function* () {
    const owner = scripted();
    const assembled = yield* scoped(function* () {
      const built = yield* host(owner);
      return Object.keys(built).toSorted();
    });
    expect(assembled).toEqual(["attach", "useDelivery", "useLifecycle", "useRunHost"]);
    // And what it may be configured with is the host-owned list, proved above
    // where the property lives.
    expect(NARROW).toEqual([true, true, true]);
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

  it("runs an authored File through the configured public host", function* () {
    const outcome = yield* scoped(function* () {
      const captured = yield* startingTree();
      const owner = scriptedOwner(captured);
      // The configured public host, over a transport whose socket is that
      // scripted owner. Everything between the two is production code: the
      // client, its three planes, the runner and the attachment.
      const built = yield* hostFor(owner);
      const transitions = yield* built.useRunHost();
      const taken = yield* WorkflowLifecycle.operations.acquireExecutor(RUN_ID);
      if (!taken.ok || taken.value.kind !== "acquired") {
        throw new Error("expected the configured host to take the acquisition");
      }
      const begun = yield* transitions.begin(taken.value.lock, {
        runId: RUN_ID,
        action: "resume",
      });
      if (!begun.ok) {
        throw begun.error;
      }
      const database = begun.value.database;
      const ambient = yield* useHostSpy();
      const rendered = yield* built.attach(
        database,
        document(
          ["# Remote", "", '<File path="NOTES.md">through the public host</File>'].join("\n"),
          database,
        ),
      );
      return {
        attached: String(rendered).trimEnd(),
        owner,
        before: captured.root.rootId,
        ambient,
      };
    });

    expect(outcome.attached).toBe("# Remote");
    // The ambient host filesystem was never asked, and the owner received one
    // proposal carrying the new root and the effect's own journal row.
    expect(outcome.ambient).toEqual([]);
    const proposals = published(outcome.owner.commits);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.["expectedWorkspaceRootId"]).toBe(outcome.before);
    expect(JSON.stringify(proposals[0]?.["publication"])).toContain("/NOTES.md");
  });

  it("clones, retains and reattaches a Repository, then publishes a Git mutation", function* () {
    const outcome = yield* scoped(function* () {
      const remote = yield* useBareRemote({
        commits: [
          {
            message: "first",
            entries: [
              { path: "which.txt", content: "main\n" },
              { path: "nested/note.md", content: "note\n" },
            ],
          },
          {
            message: "release",
            branch: "release",
            entries: [{ path: "which.txt", content: "release\n" }],
          },
        ],
      });
      const captured = yield* startingTree();
      const owner = scriptedOwner(captured);
      const source = [
        "# Remote",
        "",
        `<Repository name="project" url="${remote.locator}">`,
        '<Git.Switch branch="release" />',
        '<File path="which.txt" as="which" />',
        "",
        "switched to: {which}",
        "</Repository>",
      ].join("\n");

      /** One document execution through the configured public host. */
      function* runThrough(authored: string): Operation<{ output: string; ambient: unknown[] }> {
        return yield* scoped(function* () {
          const built = yield* hostFor(owner);
          const transitions = yield* built.useRunHost();
          const taken = yield* WorkflowLifecycle.operations.acquireExecutor(RUN_ID);
          if (!taken.ok || taken.value.kind !== "acquired") {
            throw new Error("expected the configured host to take the acquisition");
          }
          const begun = yield* transitions.begin(taken.value.lock, {
            runId: RUN_ID,
            action: "resume",
          });
          if (!begun.ok) {
            throw begun.error;
          }
          const ambient = yield* useHostSpy();
          const rendered = yield* built.attach(
            begun.value.database,
            documentOf(authored, begun.value.database),
          );
          return { output: String(rendered), ambient };
        });
      }

      const first = yield* runThrough(source);
      const afterFirst = owner.commits.length;

      // The remote is gone before the continuation runs. A replay that cloned
      // again would have nowhere to clone from, which is the point.
      yield* remote.remove();
      const again = yield* runThrough(source);
      const continuation = owner.commits.slice(afterFirst);

      return { first, again, continuation, owner };
    });

    // The document cloned on the runner, switched the checkout and read the
    // branch's own file back — all against runner-owned materialization.
    expect(outcome.first.output).toContain("switched to: release");
    expect(outcome.first.ambient).toEqual([]);
    // The owner retained the Repository identity with the root that holds its
    // checkout: one transaction carrying the mapping and the publication.
    const proposals = published(outcome.owner.commits);
    const retaining = proposals.filter((intent) => {
      const mappings = intent["mappings"];
      return (
        Array.isArray(mappings) && mappings.some((m) => Reflect.get(m, "kind") === "repository")
      );
    });
    expect(retaining).toHaveLength(1);
    expect(JSON.stringify(retaining[0]?.["publication"])).toContain("/project");
    // The retained *record* names the checkout by its logical Workspace path
    // and the remote by a fingerprint. No locator and no host path is in it:
    // the locator travels beside the record, which is where a reattachment
    // reads it from and where it is not part of retained identity.
    const retainedMappings = retaining[0]?.["mappings"];
    const proposed = Array.isArray(retainedMappings) ? retainedMappings[0] : undefined;
    const record = JSON.stringify(Reflect.get(proposed ?? {}, "record"));
    expect(record).toContain("locatorFingerprint");
    expect(record).toContain('"checkoutPath":"/repositories/');
    expect(record).not.toContain("/tmp");
    expect(record).not.toContain("/var/folders");
    expect(record).not.toContain("xmd-remote-");
    expect(record).not.toContain('locator"');
    // The Git mutation is its own owner transaction, and it starts from the
    // root the Repository creation published: one atomic step after another,
    // never one proposal carrying both.
    const gitProposal = proposals.find((intent) => {
      const held = intent["mappings"];
      return Array.isArray(held) && !held.some((m) => Reflect.get(m, "kind") === "repository");
    });
    expect(gitProposal).not.toBe(undefined);
    expect(gitProposal?.["expectedWorkspaceRootId"]).toBe(
      Reflect.get(retaining[0]?.["publication"] ?? {}, "proposedWorkspaceRootId"),
    );
    expect(Array.isArray(gitProposal?.["events"]) && gitProposal?.["events"]).toHaveLength(1);

    // The continuation reconstructed the retained checkout from the owner's
    // committed frontier, with no remote left to clone from.
    expect(outcome.again.output).toContain("switched to: release");
    expect(outcome.again.ambient).toEqual([]);
    // And it retained no second Repository: the recorded creation restored
    // rather than cloning again.
    const recreated = outcome.continuation.filter((intent) => {
      const mappings = intent["mappings"];
      return (
        Array.isArray(mappings) && mappings.some((m) => Reflect.get(m, "kind") === "repository")
      );
    });
    expect(recreated).toEqual([]);
  });

  it("installs a configured Agent profile, retains its mapping and reattaches it", function* () {
    /**
     * The profile this host configures, driving the shipped session policy.
     *
     * The provider itself stands in — establishing a conversation needs an
     * agent process, and what is under test is which durable identity this run
     * accepts. Everything around it is production code: the same
     * `resolveAgentSession` the shipped profile calls, inside the same
     * `transactAgentSessions` it commits through, reached through the
     * configured host's own `capabilities.agent`.
     */
    function profile(
      log: string[],
      asserted: ProviderAssertion,
      failBeforeCommit = false,
    ): (attachment: { readonly database: WorkflowRunDatabase }) => Operation<void> {
      return ({ database }) =>
        (function* (): Operation<void> {
          log.push("installed");
          const key = agentSessionKey(IDENTITY);
          const committed = yield* transactAgentSessions(database, function* (sessions) {
            const retained = sessions.read(key);
            // The provider is asked here, outside the owner's transaction —
            // this stands in for that — and the policy decides what the run
            // accepts.
            log.push(retained === undefined ? "provider:create" : "provider:assert");
            const resolution = resolveAgentSession(retained, POLICY, [asserted], IDENTITY);
            if (failBeforeCommit) {
              throw new Error("PlantedProfileFailure");
            }
            if (retained === undefined && resolution.kind === "reattach") {
              sessions.commit(resolution.record);
              log.push("committed");
            } else {
              log.push("reattached");
            }
          });
          if (!committed.ok) {
            throw committed.error;
          }
          // Only after the mapping is the run's does the profile speak to the
          // conversation at all.
          log.push("prompt");
        })();
    }

    const outcome = yield* scoped(function* () {
      const captured = yield* startingTree();
      const owner = scriptedOwner(captured);

      /** One attachment with this profile configured, reporting what it did. */
      function* attaching(
        log: string[],
        asserted: ProviderAssertion,
        failBeforeCommit = false,
      ): Operation<string> {
        return yield* scoped(function* () {
          const built = yield* hostFor(owner, {
            agent: profile(log, asserted, failBeforeCommit),
          });
          const transitions = yield* built.useRunHost();
          const taken = yield* WorkflowLifecycle.operations.acquireExecutor(RUN_ID);
          if (!taken.ok || taken.value.kind !== "acquired") {
            throw new Error("expected the configured host to take the acquisition");
          }
          const begun = yield* transitions.begin(taken.value.lock, {
            runId: RUN_ID,
            action: "resume",
          });
          if (!begun.ok) {
            throw begun.error;
          }
          try {
            yield* built.attach(
              begun.value.database,
              documentOf("# Remote\n", begun.value.database),
            );
            return "attached";
          } catch (error) {
            return error instanceof Error ? `raised:${error.message}` : "raised:other";
          }
        });
      }

      const mapped = (): number =>
        owner.commits.filter((intent) => {
          const mappings = intent["mappings"];
          return (
            Array.isArray(mappings) &&
            mappings.some((mapping) => Reflect.get(mapping, "kind") === "agent-session")
          );
        }).length;

      // A profile that fails before its mapping commits.
      const failing: string[] = [];
      const refused = yield* attaching(failing, ASSERTED, true);
      const afterFailure = mapped();

      // Then one that establishes and commits.
      const first: string[] = [];
      const created = yield* attaching(first, ASSERTED);
      const afterCreate = mapped();

      // A later attachment, from what the owner now retains.
      const second: string[] = [];
      const again = yield* attaching(second, ASSERTED);
      const afterReattach = mapped();

      // And one whose provider asserts a different conversation.
      const conflicting: string[] = [];
      const replaced = yield* attaching(conflicting, {
        kind: ASSERTED.kind,
        value: "another-conversation",
      });

      return {
        refused,
        failing,
        afterFailure,
        created,
        first,
        afterCreate,
        again,
        second,
        afterReattach,
        replaced,
        conflicting,
      };
    });

    // The installer ran inside the attachment, and a failure before the commit
    // retained nothing.
    expect(outcome.failing).toEqual(["installed", "provider:create"]);
    expect(outcome.refused).toContain("raised:");
    expect(outcome.afterFailure).toBe(0);
    // The next attachment establishes it: policy, then commit, then the first
    // prompt — in that order, and one mapping at the owner.
    expect(outcome.created).toBe("attached");
    expect(outcome.first).toEqual(["installed", "provider:create", "committed", "prompt"]);
    expect(outcome.afterCreate).toBe(1);
    // A later attachment reattaches the exact retained assertion, and neither
    // creates a session nor retains a second mapping.
    expect(outcome.again).toBe("attached");
    expect(outcome.second).toEqual(["installed", "provider:assert", "reattached", "prompt"]);
    expect(outcome.afterReattach).toBe(1);
    // A different conversation under the same identity is refused before any
    // replacement, and still nothing more is retained.
    expect(outcome.replaced).toContain("raised:");
    expect(outcome.conflicting).toEqual(["installed", "provider:assert"]);
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
