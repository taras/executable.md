/**
 * How a logical session was first constructed
 * (specs/native-agent-session-launch-spec.md §Construction route).
 *
 * Construction and live ownership answer different questions, and #519 keeps
 * them apart deliberately:
 *
 *     construction route: how this logical session was first constructed
 *     session coordinator: who may act on it now
 *
 * The coordinator is the single live authority and owns crash behavior. A route
 * grants no right to ensure, prompt, detach, spawn, resume, or accept history —
 * it only says which kind of thing this session is, so that a later attachment
 * cannot quietly treat an ACP-created conversation as a client-allocated one.
 *
 * The route is strict create-once durable state. It is never overwritten,
 * deleted, converted, repaired, or partially read. A conflict is a refusal, not
 * something to reconcile: both accounts describe a session that already exists,
 * and picking one would be inventing history.
 *
 * Both facts use the same natural key and the same digest the merged
 * coordinator already derives, so one session names one lease, one ownership
 * record, and one route.
 */

import { ensure, scoped, until } from "effection";
import type { Operation } from "effection";
import { agentSessionKeyDigest } from "@executablemd/runtime";
import type { AgentSessionKey } from "@executablemd/runtime";
import type { ExecutableBuildBindingV1 } from "@executablemd/core";

/**
 * The exact V1 record.
 *
 * An `acp-first` record carries no provider identity, instruction layer,
 * executable binding, process fact, or provider history — there is nothing to
 * say about a session ACP created beyond that ACP created it. A `client-native`
 * record carries no executable path, raw environment, argv, instruction text,
 * credential, transcript, process handle, or temporary path.
 */
export type AgentSessionRouteV1 =
  | {
      schema: "session-route.v1";
      route: "acp-first";
      provider: string;
      agent: string;
      sessionKey: string;
    }
  | {
      schema: "session-route.v1";
      route: "client-native";
      provider: string;
      agent: string;
      sessionKey: string;
      nativeSessionId: string;
      identityProvenance: "client-allocated";
      instructionsDigest: string;
      launcher: string;
      executableBinding: ExecutableBuildBindingV1;
    };

/** Why a route could not be used. Never carries a path or provider-private state. */
export class AgentSessionRouteError extends Error {
  override name = "AgentSessionRouteError";
}

const ACP_FIRST_MEMBERS = ["schema", "route", "provider", "agent", "sessionKey"];
const CLIENT_NATIVE_MEMBERS = [
  ...ACP_FIRST_MEMBERS,
  "nativeSessionId",
  "identityProvenance",
  "instructionsDigest",
  "launcher",
  "executableBinding",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactly(value: Record<string, unknown>, members: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === members.length && keys.every((key) => members.includes(key));
}

function parseBinding(value: unknown): ExecutableBuildBindingV1 | undefined {
  if (!isRecord(value) || value.schema !== "executable-build.v1") {
    return undefined;
  }
  if (!exactly(value, ["schema", "reportedVersion", "executableDigest"])) {
    return undefined;
  }
  const { reportedVersion, executableDigest } = value;
  if (typeof reportedVersion !== "string" || reportedVersion.length === 0) {
    return undefined;
  }
  if (!isRecord(executableDigest) || !exactly(executableDigest, ["algorithm", "value"])) {
    return undefined;
  }
  if (executableDigest.algorithm !== "sha256") {
    return undefined;
  }
  const digest = executableDigest.value;
  if (typeof digest !== "string" || !/^[0-9a-f]{64}$/.test(digest)) {
    return undefined;
  }
  return {
    schema: "executable-build.v1",
    reportedVersion,
    executableDigest: { algorithm: "sha256", value: digest },
  };
}

/**
 * Read a route strictly.
 *
 * Missing, extra, unknown-schema, or malformed state describes a session this
 * build cannot account for, and a session it cannot account for is one it must
 * not act on. There is deliberately no reader for the unmerged
 * `native-session-mapping.v1` shape: it was never a released compatibility
 * boundary, so it is unknown state and fails closed like any other.
 */
export function parseAgentSessionRoute(value: unknown): AgentSessionRouteV1 | undefined {
  if (!isRecord(value) || value.schema !== "session-route.v1") {
    return undefined;
  }
  const { provider, agent, sessionKey } = value;
  if (typeof provider !== "string" || provider.length === 0) {
    return undefined;
  }
  if (typeof agent !== "string" || agent.length === 0) {
    return undefined;
  }
  if (typeof sessionKey !== "string" || sessionKey.length === 0) {
    return undefined;
  }
  if (value.route === "acp-first") {
    return exactly(value, ACP_FIRST_MEMBERS)
      ? { schema: "session-route.v1", route: "acp-first", provider, agent, sessionKey }
      : undefined;
  }
  if (value.route !== "client-native" || !exactly(value, CLIENT_NATIVE_MEMBERS)) {
    return undefined;
  }
  const { nativeSessionId, instructionsDigest, launcher } = value;
  if (typeof nativeSessionId !== "string" || nativeSessionId.length === 0) {
    return undefined;
  }
  if (typeof instructionsDigest !== "string" || !/^[0-9a-f]{64}$/.test(instructionsDigest)) {
    return undefined;
  }
  if (typeof launcher !== "string" || launcher.length === 0) {
    return undefined;
  }
  if (value.identityProvenance !== "client-allocated") {
    return undefined;
  }
  const executableBinding = parseBinding(value.executableBinding);
  if (!executableBinding) {
    return undefined;
  }
  return {
    schema: "session-route.v1",
    route: "client-native",
    provider,
    agent,
    sessionKey,
    nativeSessionId,
    identityProvenance: "client-allocated",
    instructionsDigest,
    launcher,
    executableBinding,
  };
}

export function serializeAgentSessionRoute(route: AgentSessionRouteV1): string {
  const payload: Record<string, unknown> = {
    schema: route.schema,
    route: route.route,
    provider: route.provider,
    agent: route.agent,
    sessionKey: route.sessionKey,
  };
  if (route.route === "client-native") {
    payload.nativeSessionId = route.nativeSessionId;
    payload.identityProvenance = route.identityProvenance;
    payload.instructionsDigest = route.instructionsDigest;
    payload.launcher = route.launcher;
    payload.executableBinding = {
      schema: route.executableBinding.schema,
      reportedVersion: route.executableBinding.reportedVersion,
      executableDigest: {
        algorithm: route.executableBinding.executableDigest.algorithm,
        value: route.executableBinding.executableDigest.value,
      },
    };
  }
  return `${JSON.stringify(payload, null, 2)}\n`;
}

/** Whether a route names the key it was found under. */
export function routeNamesKey(route: AgentSessionRouteV1, key: AgentSessionKey): boolean {
  return (
    route.provider === key.provider &&
    route.agent === key.agent &&
    route.sessionKey === key.sessionKey
  );
}

/** The natural key a route names. */
export function routeKey(route: AgentSessionRouteV1): AgentSessionKey {
  return { provider: route.provider, agent: route.agent, sessionKey: route.sessionKey };
}

export interface AgentSessionRouteStore {
  /** The published route for `key`, or nothing. */
  read(key: AgentSessionKey): Operation<AgentSessionRouteV1 | undefined>;
  /**
   * Publish `candidate` create-once, and answer with the winner.
   *
   * The winner may be an earlier publication rather than this candidate. It is
   * never overwritten to make this caller's account true: whoever published
   * first described the session that exists, and a later caller either agrees
   * with that account or refuses.
   */
  publish(candidate: AgentSessionRouteV1): Operation<AgentSessionRouteV1>;
}

/**
 * A store whose lifetime is the partition holding it.
 *
 * Same semantics as the durable one, no filesystem. Every `<Test>` owns one, so
 * two sibling tests naming one session are two sessions rather than two writers
 * of one route.
 */
export function createMemorySessionRouteStore(): AgentSessionRouteStore {
  const published = new Map<string, string>();
  return {
    // deno-lint-ignore require-yield
    *read(key) {
      const held = published.get(agentSessionKeyDigest(key));
      if (held === undefined) {
        return undefined;
      }
      // Round-tripped through the same strict reader the durable store uses, so
      // parity is a property of the code rather than a claim about it.
      return parseAgentSessionRoute(JSON.parse(held));
    },
    // deno-lint-ignore require-yield
    *publish(candidate) {
      const digest = agentSessionKeyDigest(routeKey(candidate));
      const held = published.get(digest);
      if (held !== undefined) {
        const winner = parseAgentSessionRoute(JSON.parse(held));
        if (!winner) {
          throw new AgentSessionRouteError(
            `the construction route for session "${candidate.sessionKey}" is state this build ` +
              `cannot account for, so it is not acted on`,
          );
        }
        return winner;
      }
      published.set(digest, serializeAgentSessionRoute(candidate));
      return candidate;
    },
  };
}

type HostCall = (...args: unknown[]) => unknown;

function callable(host: object, name: string): HostCall | undefined {
  const member: unknown = Reflect.get(host, name);
  if (typeof member !== "function") {
    return undefined;
  }
  return (...args) => Reflect.apply(member, host, args);
}

/**
 * The filesystem surface the durable store needs, read off the host rather than
 * imported, so this module stays loadable where it is never constructed.
 */
interface RouteHost {
  mkdir(path: string, options: { recursive: boolean; mode: number }): Promise<unknown>;
  writeTextFile(path: string, data: string, options: { mode: number }): Promise<unknown>;
  readTextFile(path: string): Promise<string>;
  open(path: string, options: Record<string, boolean>): Promise<unknown>;
  link(from: string, to: string): Promise<unknown>;
  remove(path: string): Promise<unknown>;
}

function routeHost(): RouteHost | undefined {
  const found: unknown = Reflect.get(globalThis, "Deno");
  if (typeof found !== "object" || found === null) {
    return undefined;
  }
  const names = ["mkdir", "writeTextFile", "readTextFile", "open", "link", "remove"] as const;
  const calls = names.map((name) => callable(found, name));
  if (calls.some((call) => call === undefined)) {
    return undefined;
  }
  const [mkdir, writeTextFile, readTextFile, open, link, remove] = calls as HostCall[];
  return {
    mkdir: (path, options) => Promise.resolve(mkdir(path, options)),
    writeTextFile: (path, data, options) => Promise.resolve(writeTextFile(path, data, options)),
    readTextFile: (path) => Promise.resolve(readTextFile(path)) as Promise<string>,
    open: (path, options) => Promise.resolve(open(path, options)),
    link: (from, to) => Promise.resolve(link(from, to)),
    remove: (path) => Promise.resolve(remove(path)),
  };
}

interface HostFile {
  sync(): Promise<unknown>;
  close(): void;
}

function hostFile(value: unknown): HostFile | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const sync = callable(value, "sync");
  const close = callable(value, "close");
  if (!sync || !close) {
    return undefined;
  }
  return { sync: () => Promise.resolve(sync()), close: () => void close() };
}

function isMissing(cause: unknown): boolean {
  return (
    (typeof cause === "object" && cause !== null && Reflect.get(cause, "code") === "ENOENT") ||
    (cause instanceof Error && cause.name === "NotFound")
  );
}

function exists(cause: unknown): boolean {
  return (
    (typeof cause === "object" && cause !== null && Reflect.get(cause, "code") === "EEXIST") ||
    (cause instanceof Error && cause.name === "AlreadyExists")
  );
}

/** Whether this host can keep durable routes at all. */
export function hasDenoSessionRouteStore(): boolean {
  return routeHost() !== undefined;
}

/**
 * The durable store, rooted beside the coordinator's leases and ownership
 * records so one session's three facts live in one namespace.
 *
 * Publication is create-once by hard link. A rename would overwrite, and
 * overwriting is the one thing a create-once record may never do: the loser of
 * a race has to read the winner, not replace it. `link()` answering EEXIST *is*
 * the answer, and the staging file is removed whichever way it went.
 */
export function createDenoSessionRouteStore(root: string): AgentSessionRouteStore | undefined {
  const found = routeHost();
  if (!found) {
    return undefined;
  }
  const host: RouteHost = found;
  const directory = `${root}/routes`;

  function* prepared(): Operation<void> {
    yield* until(host.mkdir(root, { recursive: true, mode: 0o700 }));
    yield* until(host.mkdir(directory, { recursive: true, mode: 0o700 }));
  }

  function destination(key: AgentSessionKey): string {
    return `${directory}/${agentSessionKeyDigest(key)}.json`;
  }

  function* readAt(path: string): Operation<AgentSessionRouteV1 | undefined> {
    const text = yield* until(
      host.readTextFile(path).catch((cause: unknown) => {
        if (isMissing(cause)) {
          return undefined;
        }
        throw cause;
      }),
    );
    if (text === undefined) {
      // Absence, and only absence: no file is the one answer that means this
      // session has not been constructed yet.
      return undefined;
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new AgentSessionRouteError(
        `the construction route record for this session is not readable, so it is not acted on`,
      );
    }
    const route = parseAgentSessionRoute(value);
    if (!route) {
      // Present, and unreadable by this build. Treating that as "no route" is
      // how a session gets constructed a second way.
      throw new AgentSessionRouteError(
        `the construction route record for this session is state this build cannot account ` +
          `for, so it is not acted on`,
      );
    }
    return route;
  }

  function* flush(path: string): Operation<void> {
    const opened = hostFile(yield* until(host.open(path, { read: true })));
    if (opened) {
      yield* until(opened.sync());
      opened.close();
    }
  }

  return {
    *read(key) {
      yield* prepared();
      const path = destination(key);
      const route = yield* readAt(path);
      if (route === undefined) {
        return undefined;
      }
      // A record found under one digest that names another key has moved, and
      // a moved record is state this build cannot account for.
      if (!routeNamesKey(route, key)) {
        throw new AgentSessionRouteError(
          `the construction route for session "${key.sessionKey}" names a different session, ` +
            `so it is not acted on`,
        );
      }
      return route;
    },

    publish(candidate) {
      // Scoped, so the staging file is removed when this publication ends
      // rather than when the caller's scope does. A finalizer registered in the
      // caller's scope would leave one staging file per publication lying in
      // the namespace for the life of the run.
      return scoped(function* (): Operation<AgentSessionRouteV1> {
        yield* prepared();
        const key = routeKey(candidate);
        const path = destination(key);

        // Complete and durable before anything can observe it: a reader that
        // found a half-written winner would be reading a session nobody has.
        const staging = `${path}.${crypto.randomUUID()}.staging`;
        yield* until(
          host.writeTextFile(staging, serializeAgentSessionRoute(candidate), { mode: 0o600 }),
        );
        yield* ensure(function* () {
          // The winner is published or it is not; a leftover staging file changes
          // neither answer, so a failure to remove one is not worth raising.
          yield* until(host.remove(staging).catch(() => undefined));
        });
        yield* flush(staging);

        const linked = yield* until(
          host.link(staging, path).then(
            () => true,
            (cause: unknown) => {
              if (exists(cause)) {
                return false;
              }
              throw cause;
            },
          ),
        );
        if (linked) {
          yield* flush(directory);
          return candidate;
        }

        const winner = yield* readAt(path);
        if (!winner || !routeNamesKey(winner, key)) {
          throw new AgentSessionRouteError(
            `the construction route for session "${candidate.sessionKey}" is state this build ` +
              `cannot account for, so it is not acted on`,
          );
        }
        return winner;
      });
    },
  };
}
