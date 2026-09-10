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
import { ensure, type Operation, resource, scoped, sleep, spawn, withResolvers } from "effection";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readTextFile } from "@effectionx/fs";
import { agentIdentityComponents, collect, retainedSource } from "@executablemd/core";
import { executeInstalled } from "@executablemd/core/host";
import type {
  AcpRuntimeDoctorReport,
  AcpRuntimeHandle,
  AcpRuntimeOptions,
  ProbeCapableRuntime,
} from "@executablemd/acp";
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
import { useWorkflowAgentProfile, workflowSessionPolicyDigest } from "../src/workflow-agent.ts";
import type { WorkflowAgentProfileOptions } from "../src/workflow-agent.ts";
import { createFakeAcp, makeStore, tripwireAcp } from "./support/fake-acp.ts";
import type { FakeAcp } from "./support/fake-acp.ts";
import { useTempDirectory } from "@executablemd/test-support/temp";

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

  it("clones and retains a Repository, then continues its Git mutation from that history", function* () {
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
      // Installed around both executions, at the position a runtime entrypoint
      // installs it and with a working directory a workflow run must never
      // resolve against: anything either execution let fall through to the
      // caller's filesystem is visible here rather than silent.
      const ambient = yield* useHostSpy();
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
      function* runThrough(
        authored: string,
        socket: OwnerSocket,
      ): Operation<{ output: string; failure: string }> {
        return yield* scoped(function* () {
          const built = yield* hostFor({ socket });
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
            const rendered = yield* built.attach(
              begun.value.database,
              documentOf(authored, begun.value.database),
            );
            return { output: String(rendered), failure: "" };
          } catch (error) {
            return {
              output: "",
              failure: error instanceof Error ? error.message : "other",
            };
          }
        });
      }

      // The first execution clones, retains the Repository, and is cancelled
      // with the Git mutation's proposal still in flight. So the owner decided
      // the creation and never decided the mutation, and what it holds is the
      // prefix it accepted rather than a history nobody wrote.
      const withheld: Record<string, unknown>[] = [];
      const proposing = withResolvers<void>();
      const attempt = yield* spawn(() =>
        runThrough(
          source,
          withholding(owner.socket, withheld, () => proposing.resolve()),
        ),
      );
      yield* proposing.operation;
      yield* attempt.halt();

      const accepted = owner.commits.length;
      const asked = owner.sent.length;
      const prefix = owner.entries();

      // The remote is gone before the continuation runs, so nothing it does
      // can involve the network — and what it continues from is the journal the
      // owner retained beside the root and the mapping.
      yield* remote.remove();
      const again = yield* runThrough(source, owner.socket);

      return {
        withheld,
        again,
        ambient,
        retained: prefix,
        creation: owner.commits.slice(0, accepted),
        continuation: owner.commits.slice(accepted),
        replayed: owner.sent.slice(asked),
        owner,
      };
    });

    // One proposal reached the owner, carrying the Repository mapping and the
    // root that holds its checkout; the mutation's proposal reached it never.
    const retaining = published(outcome.creation);
    expect(retaining).toHaveLength(1);
    expect(JSON.stringify(retaining[0]?.["publication"])).toContain("/project");
    expect(outcome.withheld).toHaveLength(1);
    expect(only(outcome.withheld[0])).toContain('"type":"workspace_git_switch"');
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

    // What the owner holds is one coherent prefix: the creation's own journal
    // row, carrying the root that transaction published, and nothing from the
    // transaction it never decided. A root and a mapping beside a journal
    // missing the transaction that created them is not a state this owner can
    // be in, and neither is a journal holding a transaction the owner refused
    // to decide.
    const creationRoot = Reflect.get(
      retaining[0]?.["publication"] ?? {},
      "proposedWorkspaceRootId",
    );
    const repositoryEvent = outcome.retained.find((entry) =>
      entry.record.includes('"type":"workspace_repository"'),
    );
    expect(repositoryEvent?.workspaceRootId).toBe(creationRoot);
    expect(
      outcome.retained.filter((entry) => entry.record.includes('"type":"workspace_git_switch"')),
    ).toEqual([]);
    expect(outcome.retained.at(-1)?.workspaceRootId).toBe(creationRoot);

    // The continuation read that prefix — anchored pages, from the terminal
    // event the frontier named.
    const pages = outcome.replayed.filter((request) => request["command"] === "journal");
    expect(pages.length > 0).toBe(true);
    expect(pages[0]?.["anchorEventId"]).toBe(outcome.retained.at(-1)?.eventId);

    // The recorded creation restored rather than cloning again — the remote it
    // was cloned from no longer exists — and the checkout the Git mutation
    // needed was reconstructed from the root that replayed record selected.
    // The live switch started from exactly that root and moved a checkout that
    // really was on `main`, which is what a checkout rebuilt from the recorded
    // Workspace and proved against the record looks like.
    expect(outcome.again.failure).toBe("");
    const mutation = published(outcome.continuation);
    const switched = mutation.find((intent) =>
      only(intent).includes('"type":"workspace_git_switch"'),
    );
    expect(switched?.["expectedWorkspaceRootId"]).toBe(creationRoot);
    expect(only(switched)).toContain('"before":{"branch":"main"');
    expect(only(switched)).toContain('"after":{"branch":"release"');
    // And then the branch's own file, read live from that same checkout.
    const read = mutation.find((intent) => only(intent).includes('"type":"workspace_file"'));
    expect(only(read)).toContain('"content":"release');
    expect(outcome.again.output).toContain("switched to: release");

    // Two transactions and no third: only the work the cancellation left
    // undone. The mutation's own journal row carries the root it published,
    // and that root is the run's — a read moves nothing, so the switch is the
    // last thing that moved it.
    expect(mutation).toHaveLength(2);
    const mutationRoot = Reflect.get(switched?.["publication"] ?? {}, "proposedWorkspaceRootId");
    const gitEvent = outcome.owner
      .entries()
      .find((entry) => entry.record.includes('"type":"workspace_git_switch"'));
    expect(gitEvent?.workspaceRootId).toBe(mutationRoot);
    expect(outcome.owner.currentRoot).toBe(mutationRoot);
    // Nothing retained a second Repository, and the ambient host filesystem was
    // asked for nothing by either execution.
    const recreated = mutation.filter((intent) => {
      const mappings = intent["mappings"];
      return (
        Array.isArray(mappings) && mappings.some((m) => Reflect.get(m, "kind") === "repository")
      );
    });
    expect(recreated).toEqual([]);
    expect(outcome.ambient).toEqual([]);
  });

  it("prompts through the shipped Agent profile, and retains the conversation it got", function* () {
    const root = yield* useTempDirectory("xmd-remote-agent-");
    const source = yield* readTextFile(join(FIXTURES, "claude-session.md"));

    const outcome = yield* scoped(function* () {
      const captured = yield* startingTree();
      const owner = scriptedOwner(captured);
      // One provider store across every attachment below: a provider keeps its
      // sessions across processes, so a fresh one would be a provider that
      // forgot rather than a run that came back.
      const store = makeStore();

      // The first attachment is cancelled while the second prompt's turn is in
      // flight. The session has been established and its mapping has committed
      // by then, so what the cancellation leaves unfinished is the turn rather
      // than the retention — which is what gives the restart below something
      // to resolve from.
      const live = createFakeAcp();
      live.script({ reply: "the reviewer saw the release notes" });
      live.script({ reply: "", manual: true });
      const marks: Mark[] = [];
      const interrupted = yield* spawn(() =>
        attaching(sampled(owner.socket, live, marks), root, source, {
          createRuntime: live.create,
          sessionStore: store,
        }),
      );
      yield* live.startedTurns(2);
      yield* interrupted.halt();
      const created = retained(owner);
      const asserted = storeAssertions(store);

      // The restart: the same run, the same provider store, and a provider that
      // answers the turn the first attempt never finished.
      const resumed = createFakeAcp();
      resumed.script({ reply: "and they recommended shipping it" });
      const again = yield* attaching(owner.socket, root, source, {
        createRuntime: resumed.create,
        sessionStore: store,
      });

      // And once the document has finished, a further attachment restores it
      // from what the owner retains and reaches no provider at all — not even
      // to create a runtime.
      const reached: string[] = [];
      const replayed = yield* attaching(owner.socket, root, source, {
        createRuntime: tripwireAcp((what) => reached.push(what)),
        sessionStore: store,
      });

      return {
        created,
        asserted,
        marks,
        establishedFirst: established(live),
        promptedFirst: [...live.prompts],
        again,
        establishedAgain: established(resumed),
        promptedAgain: [...resumed.prompts],
        reattached: retained(owner),
        held: storeAssertions(store),
        replayed,
        reached,
      };
    });

    // One session, established on the runner, and one mapping at the owner
    // carrying exactly what the provider asserted about it — under the shipped
    // session policy rather than a digest this test invented.
    expect(outcome.establishedFirst).toHaveLength(1);
    expect(outcome.created).toHaveLength(1);
    expect(member(outcome.created[0], "provider")).toBe("acpx");
    expect(member(outcome.created[0], "policy")).toBe(workflowSessionPolicyDigest());
    expect(member(member(outcome.created[0], "assertion"), "kind")).toBe("acpx.agentSessionId");
    expect([String(member(member(outcome.created[0], "assertion"), "value"))]).toEqual(
      outcome.asserted,
    );
    // The order is the whole of it, sampled at the owner: the conversation
    // existed, the owner then accepted which one it was, and only then did
    // anything prompt it.
    expect(outcome.marks).toEqual([{ ensured: 1, prompts: 0 }]);
    expect(outcome.promptedFirst).toHaveLength(2);
    expect(outcome.promptedFirst[0]).toContain("What did the reviewer see?");

    // The restart reattaches the exact conversation: the same placement, the
    // same provider-native identity, no second session and no second mapping.
    expect(outcome.again).toBe("attached");
    expect(outcome.establishedAgain).toEqual(outcome.establishedFirst);
    expect(outcome.held).toEqual(outcome.asserted);
    expect(outcome.reattached).toEqual(outcome.created);
    // And it prompted only the work the cancellation left unfinished.
    expect(outcome.promptedAgain).toHaveLength(1);
    expect(outcome.promptedAgain[0]).toContain("And what did they recommend?");

    // A completed document restores without a provider.
    expect(outcome.replayed).toBe("attached");
    expect(outcome.reached).toEqual([]);
  });

  it("proposes no mapping for a session that never became one", function* () {
    const captured = yield* startingTree();
    const root = yield* useTempDirectory("xmd-remote-agent-window-");
    const source = yield* readTextFile(join(FIXTURES, "claude-session.md"));

    // A provider whose establishment fails outright.
    const failed = yield* scoped(function* () {
      const owner = scriptedOwner(captured);
      const outcome = yield* attaching(owner.socket, root, source, {
        createRuntime: establishing(
          () => {},
          () => Promise.reject(new Error("PlantedEstablishFailure")),
          [],
        ),
        sessionStore: makeStore(),
      });
      return { outcome, proposed: retained(owner) };
    });

    // And one cancelled with the establishment still in flight — a real
    // Effection cancellation of the attachment, in the window between asking a
    // provider for a conversation and retaining which one it is.
    const cancelled = yield* scoped(function* () {
      const owner = scriptedOwner(captured);
      const store = makeStore();
      const asking = withResolvers<void>();
      const closed: string[] = [];
      let answer: (handle: AcpRuntimeHandle) => void = () => {};
      const attempt = yield* spawn(() =>
        attaching(owner.socket, root, source, {
          createRuntime: establishing(
            () => asking.resolve(),
            () =>
              new Promise<AcpRuntimeHandle>((resolve) => {
                answer = resolve;
              }),
            closed,
          ),
          sessionStore: store,
        }),
      );
      yield* asking.operation;
      const halting = yield* spawn(() => attempt.halt());
      // Cancellation is delivered on microtasks, so by the next macrotask the
      // provider's own cleanup is what is waiting for this answer rather than
      // the run. `closed` below is what confirms this stood in that window: a
      // provider that answers a cancelled establishment has a live session to
      // give back, and giving it back is the only thing left to do with it.
      yield* sleep(0);
      answer(ESTABLISHED_LATE);
      yield* halting;
      return {
        closed,
        proposed: retained(owner),
        asserted: storeAssertions(store),
      };
    });

    expect(failed.outcome).toContain("raised:");
    expect(failed.proposed).toEqual([]);
    // The cancellation landed where it was aimed, and what the provider
    // answered afterwards was closed rather than adopted.
    expect(cancelled.closed).toEqual(["cancelled before the session was established"]);
    // Nothing was retained and nothing was asserted, so a later attachment
    // resolves from an empty run rather than from a conversation nobody can
    // name.
    expect(cancelled.proposed).toEqual([]);
    expect(cancelled.asserted).toEqual([]);
  });

  it("refuses a conversation the provider replaced, before prompting or retaining", function* () {
    const captured = yield* startingTree();
    const root = yield* useTempDirectory("xmd-remote-agent-conflict-");
    const source = yield* readTextFile(join(FIXTURES, "claude-session.md"));

    const outcome = yield* scoped(function* () {
      // One run that established a session, so what the owner below retains is
      // a mapping this stack actually wrote rather than one this test composed.
      const establishedRun = scriptedOwner(captured);
      const store = makeStore();
      const live = createFakeAcp();
      live.script({ reply: "the reviewer saw the release notes" });
      live.script({ reply: "and they recommended shipping it" });
      const first = yield* attaching(establishedRun.socket, root, source, {
        createRuntime: live.create,
        sessionStore: store,
      });
      const record = retained(establishedRun);

      // The same run as an owner holds it, and a provider whose store now
      // asserts a different conversation under the same placement.
      const owner = scriptedOwner(captured, { agentSessions: record });
      const replacement = makeStore();
      for (const [key, held] of store.records) {
        replacement.records.set(key, {
          ...held,
          agentSessionId: "another-conversation",
        });
      }
      const provider = createFakeAcp();
      const refused = yield* attaching(owner.socket, root, source, {
        createRuntime: provider.create,
        sessionStore: replacement,
      });
      return {
        first,
        record,
        refused,
        ensured: provider.ensured.length,
        prompts: provider.prompts.length,
        proposed: retained(owner),
      };
    });

    expect(outcome.first).toBe("attached");
    expect(outcome.record).toHaveLength(1);
    // Refused where the decision belongs: before a replacement session is
    // established and before anything is prompted. The owner was asked to
    // retain nothing, so what it holds is still the conversation this run had.
    expect(outcome.refused).toContain("different durable identity");
    expect(outcome.ensured).toBe(0);
    expect(outcome.prompts).toBe(0);
    expect(outcome.proposed).toEqual([]);
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

/** Where the workflow Agent documents this suite drives live. */
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "workflow-agent");

/**
 * The journal records one proposal carries, as the owner receives them.
 *
 * Read out of the intent rather than re-encoded, because a record is a string
 * on the wire and searching its JSON encoding would be searching the escaping.
 */
function only(intent: Record<string, unknown> | undefined): string {
  const events = intent?.["events"];
  return (Array.isArray(events) ? events : []).map((event) => String(event)).join("");
}

/** One member of a value nothing has checked. */
function member(value: unknown, name: string): unknown {
  return value !== null && typeof value === "object" ? Reflect.get(value, name) : undefined;
}

/**
 * The Agent-session mapping records this owner was asked to retain, in order.
 *
 * Read back out of the intents it received, so what is counted is what crossed
 * rather than what this process believes it staged.
 */
function retained(owner: {
  readonly commits: readonly Record<string, unknown>[];
}): Record<string, unknown>[] {
  return owner.commits.flatMap((intent) => {
    const proposed = intent["mappings"];
    return (Array.isArray(proposed) ? proposed : [])
      .filter((mapping) => member(mapping, "kind") === "agent-session")
      .map((mapping) => JSON.parse(JSON.stringify(member(mapping, "record"))));
  });
}

/** The distinct sessions this provider was asked to establish. */
function established(fake: FakeAcp): string[] {
  return [...new Set(fake.ensured.map((input) => input.sessionKey))].sort();
}

/** Every provider-native identity the substituted store currently holds. */
function storeAssertions(store: ReturnType<typeof makeStore>): string[] {
  return [...store.records.values()]
    .flatMap((record) => (record.agentSessionId === undefined ? [] : [record.agentSessionId]))
    .sort();
}

/** What the provider had done by the time the owner accepted a mapping. */
interface Mark {
  readonly ensured: number;
  readonly prompts: number;
}

/**
 * The owner's socket, with the provider sampled at each mapping commit.
 *
 * The scripted owner answers inside `send`, so what is read after it returns is
 * what the provider had done at the moment the mapping was accepted. That is
 * the only place the order between establishing a conversation, retaining which
 * one it is, and prompting it can be observed at all — afterwards, all three
 * have happened.
 */
function sampled(socket: OwnerSocket, fake: FakeAcp, marks: Mark[]): OwnerSocket {
  return {
    send(data: string): void {
      const intent: Record<string, unknown> = JSON.parse(data);
      const proposed = intent["mappings"];
      const carries = (Array.isArray(proposed) ? proposed : []).some(
        (mapping) => member(mapping, "kind") === "agent-session",
      );
      socket.send(data);
      if (carries) {
        marks.push({
          ensured: fake.ensured.length,
          prompts: fake.prompts.length,
        });
      }
    },
    close(): void {
      socket.close();
    },
    addEventListener(type: "message" | "close" | "error", listener: SocketListener): void {
      socket.addEventListener(type, listener);
    },
    removeEventListener(type: "message" | "close" | "error", listener: SocketListener): void {
      socket.removeEventListener(type, listener);
    },
  };
}

/** What a turn against a session that was never established would do. */
function tooEarly(): never {
  throw new Error("PLANTED-TURN-WITHOUT-A-SESSION");
}

/**
 * A provider whose establishment does one thing: what a case here tells it to.
 *
 * Two of the cases are about the window between asking a provider for a
 * conversation and retaining which one it is. Nothing is retained inside it, so
 * what has to be driven is the provider's own answer — one that fails, and one
 * that never comes.
 */
function establishing(
  asking: () => void,
  answer: () => Promise<AcpRuntimeHandle>,
  closed: string[],
): (options: AcpRuntimeOptions) => ProbeCapableRuntime {
  return function create(): ProbeCapableRuntime {
    return {
      doctor(): Promise<AcpRuntimeDoctorReport> {
        return Promise.resolve({ ok: true, message: "fake agent ready" });
      },
      ensureSession(): Promise<AcpRuntimeHandle> {
        asking();
        return answer();
      },
      startTurn: tooEarly,
      runTurn: tooEarly,
      cancel(): Promise<void> {
        return Promise.resolve();
      },
      close(input: { readonly handle: AcpRuntimeHandle; readonly reason: string }): Promise<void> {
        closed.push(input.reason);
        return Promise.resolve();
      },
    };
  };
}

/**
 * The session a cancelled establishment answers with, too late to be used.
 *
 * A provider asked for a conversation answers whether or not anybody is still
 * waiting, so this is a live session with nothing left to do with it but give
 * it back.
 */
const ESTABLISHED_LATE: AcpRuntimeHandle = {
  sessionKey: "cancelled-session",
  backend: "acpx",
  runtimeSessionName: "cancelled-session",
  acpxRecordId: "cancelled-session",
  backendSessionId: "acp:cancelled-session",
  agentSessionId: "agent-session:cancelled-session",
};

/**
 * One authored Agent document, executed as this run's root inside the
 * attachment.
 *
 * Installed the way `xmd` itself installs it: `<Session>` names durable work
 * after its own invocation, so the execution is told about the identity
 * components rather than having them registered around it.
 */
function prompting(source: string, database: WorkflowRunDatabase): Operation<unknown> {
  return scoped(function* () {
    return yield* collect(
      yield* executeInstalled(
        {
          ...retainedSource("workflows/claude-session.md", source),
          stream: database.journal,
        },
        [{ components: agentIdentityComponents() }],
      ),
    );
  });
}

/**
 * One attachment with the shipped Agent profile configured, and what it did.
 *
 * The profile is `useWorkflowAgentProfile()` itself, passed through the public
 * configuration's `capabilities.agent`; only the agent process and the store it
 * keeps its own sessions in are substituted.
 */
function attaching(
  socket: OwnerSocket,
  root: string,
  source: string,
  provider: {
    readonly createRuntime: WorkflowAgentProfileOptions["createRuntime"];
    readonly sessionStore: WorkflowAgentProfileOptions["sessionStore"];
  },
): Operation<string> {
  return scoped(function* () {
    const built = yield* hostFor(
      { socket },
      {
        agent: (attachment) =>
          useWorkflowAgentProfile({
            root,
            attachment,
            defaultAgent: "claude",
            ...provider,
          }),
      },
    );
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
      yield* built.attach(begun.value.database, prompting(source, begun.value.database));
      return "attached";
    } catch (error) {
      return error instanceof Error ? `raised:${error.message}` : "raised:other";
    }
  });
}

/**
 * The owner's socket, with one Workspace proposal held back.
 *
 * How a partial history is produced without inventing one. The Repository
 * creation commits whole — root, staged content, mapping and its own journal
 * row — and the proposal after it is still in flight when the run is
 * cancelled: it never reaches the owner, so the owner never decides it and
 * appends nothing for it. What is left is a prefix an owner can actually be
 * holding, with real live work after it.
 */
function withholding(
  socket: OwnerSocket,
  withheld: Record<string, unknown>[],
  reached: () => void,
): OwnerSocket {
  return {
    send(data: string): void {
      const intent: Record<string, unknown> = JSON.parse(data);
      const publication = intent["publication"];
      const mappings = intent["mappings"];
      const creation = (Array.isArray(mappings) ? mappings : []).some(
        (mapping) => member(mapping, "kind") === "repository",
      );
      if (withheld.length === 0 && publication !== null && publication !== undefined && !creation) {
        withheld.push(intent);
        reached();
        return;
      }
      socket.send(data);
    },
    close(): void {
      socket.close();
    },
    addEventListener(type: "message" | "close" | "error", listener: SocketListener): void {
      socket.addEventListener(type, listener);
    },
    removeEventListener(type: "message" | "close" | "error", listener: SocketListener): void {
      socket.removeEventListener(type, listener);
    },
  };
}
