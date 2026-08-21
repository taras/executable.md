/**
 * The provider's durable Agent-session mapping
 * (specs/native-agent-session-launch-spec.md §Durability and replay).
 *
 * A client-allocated identity is chosen once and can never be chosen again.
 * That makes this store's only interesting operation creation, and creation's
 * only interesting property exclusivity: two processes preparing the same
 * logical session must end up with one identity between them, not one each.
 * A second identity would not fail — it would succeed, against a conversation
 * nobody has seen.
 *
 * So publication is a hard link, which the filesystem refuses rather than
 * replaces. The candidate is written complete before it is published, so an
 * interruption leaves either no mapping or a whole one; a reader never sees
 * half a record and never repairs one.
 *
 * This is deliberately not an ACPX record. ACPX owns what it knows about its
 * own sessions and is free to forget them; this is what XMD knows about an
 * identity it allocated, and forgetting it would lose the conversation.
 */

import type { ExecutableBuildBindingV1, IdentityProvenance } from "@executablemd/core";
import { sameExecutableBuild } from "@executablemd/core";
import { type Operation, ensure, scoped, until } from "effection";
import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const SCHEMA = "native-session-mapping.v1";

/** Which logical Agent session a mapping belongs to. */
export interface NativeSessionKey {
  provider: string;
  agent: string;
  sessionKey: string;
}

/**
 * What the provider retained about one logical session's native identity.
 *
 * It holds no executable path, no live handle and no instruction text — the
 * same restriction the journal record carries, for the same reason: this file
 * outlives the host layout that produced it.
 */
export interface NativeSessionMapping extends NativeSessionKey {
  schema: typeof SCHEMA;
  nativeSessionId: string;
  identityProvenance: IdentityProvenance;
  /**
   * The instruction layer this session was established with.
   *
   * Retained as a digest rather than the text: the store answers "is this the
   * same layer?", and holding the text would put prepared instructions in a
   * second place for no additional answer.
   */
  instructionsDigest: string;
  launcher: string;
  executableBinding?: ExecutableBuildBindingV1;
}

/** A mapping that cannot be reconciled with what is already retained. */
export class NativeSessionConflict extends Error {
  override name = "NativeSessionConflict";
  constructor(message: string) {
    super(message);
  }
}

export interface NativeSessionMappingStore {
  read(key: NativeSessionKey): Operation<NativeSessionMapping | undefined>;
  /**
   * Publish `mapping` unless one already exists, and return whichever one is
   * now authoritative. A caller adopts the result; it never assumes its own
   * candidate won.
   */
  create(mapping: NativeSessionMapping): Operation<NativeSessionMapping>;
}

/**
 * The file one logical session's mapping lives in.
 *
 * Named by digest so that an agent or session name containing a separator, a
 * newline, or a character this filesystem reserves cannot decide where the
 * record goes — or reach another session's record.
 */
function fileFor(root: string, key: NativeSessionKey): string {
  const name = createHash("sha256")
    .update(JSON.stringify([key.provider, key.agent, key.sessionKey]))
    .digest("hex");
  return join(root, `${name}.json`);
}

function serialize(mapping: NativeSessionMapping): string {
  const payload: Record<string, unknown> = {
    schema: mapping.schema,
    provider: mapping.provider,
    agent: mapping.agent,
    sessionKey: mapping.sessionKey,
    nativeSessionId: mapping.nativeSessionId,
    identityProvenance: mapping.identityProvenance,
    instructionsDigest: mapping.instructionsDigest,
    launcher: mapping.launcher,
  };
  if (mapping.executableBinding !== undefined) {
    payload.executableBinding = mapping.executableBinding;
  }
  return `${JSON.stringify(payload, null, 2)}\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseBinding(value: unknown): ExecutableBuildBindingV1 | undefined {
  if (!isRecord(value) || value.schema !== "executable-build.v1") {
    return undefined;
  }
  const { reportedVersion, executableDigest } = value;
  if (typeof reportedVersion !== "string" || reportedVersion.length === 0) {
    return undefined;
  }
  if (!isRecord(executableDigest) || executableDigest.algorithm !== "sha256") {
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
 * Read a mapping strictly.
 *
 * Anything this build cannot fully account for — a missing field, an unknown
 * schema, a binding it cannot compare — is a refusal rather than a partial
 * reading. There is no legacy shape to infer and no migration reader: a record
 * this build cannot understand describes a session it must not act on.
 */
export function parseNativeSessionMapping(value: unknown): NativeSessionMapping | undefined {
  if (!isRecord(value) || value.schema !== SCHEMA) {
    return undefined;
  }
  const { provider, agent, sessionKey, nativeSessionId, identityProvenance, launcher } = value;
  const { instructionsDigest } = value;
  for (const field of [
    provider,
    agent,
    sessionKey,
    nativeSessionId,
    launcher,
    instructionsDigest,
  ]) {
    if (typeof field !== "string" || field.length === 0) {
      return undefined;
    }
  }
  if (identityProvenance !== "provider-returned" && identityProvenance !== "client-allocated") {
    return undefined;
  }
  const mapping: NativeSessionMapping = {
    schema: SCHEMA,
    provider: provider as string,
    agent: agent as string,
    sessionKey: sessionKey as string,
    nativeSessionId: nativeSessionId as string,
    identityProvenance,
    instructionsDigest: instructionsDigest as string,
    launcher: launcher as string,
  };
  // The same rule the journal enforces, for the same reason: an allocated
  // identity without the build it was established against cannot be compared
  // to anything later, so it cannot be safely resumed.
  if (identityProvenance === "client-allocated") {
    const binding = parseBinding(value.executableBinding);
    if (!binding) {
      return undefined;
    }
    mapping.executableBinding = binding;
  } else if (value.executableBinding !== undefined) {
    return undefined;
  }
  return mapping;
}

/** Whether two mappings agree on every field, binding included. */
export function sameNativeSessionMapping(
  left: NativeSessionMapping,
  right: NativeSessionMapping,
): boolean {
  if (
    left.provider !== right.provider ||
    left.agent !== right.agent ||
    left.sessionKey !== right.sessionKey ||
    left.nativeSessionId !== right.nativeSessionId ||
    left.identityProvenance !== right.identityProvenance ||
    left.launcher !== right.launcher ||
    left.instructionsDigest !== right.instructionsDigest
  ) {
    return false;
  }
  if (left.executableBinding === undefined || right.executableBinding === undefined) {
    return left.executableBinding === right.executableBinding;
  }
  return sameExecutableBuild(left.executableBinding, right.executableBinding);
}

/** Whether a mapping describes the session it was looked up under. */
export function describesSession(retained: NativeSessionKey, key: NativeSessionKey): boolean {
  return (
    retained.provider === key.provider &&
    retained.agent === key.agent &&
    retained.sessionKey === key.sessionKey
  );
}

function* readMapping(file: string): Operation<NativeSessionMapping | undefined> {
  const text = yield* until(
    readFile(file, "utf8").catch((cause: unknown) => {
      if (isRecord(cause) && cause.code === "ENOENT") {
        return undefined;
      }
      throw cause;
    }),
  );
  if (text === undefined) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new NativeSessionConflict("the retained native session mapping is not readable");
  }
  const mapping = parseNativeSessionMapping(parsed);
  if (!mapping) {
    throw new NativeSessionConflict("the retained native session mapping is not valid");
  }
  return mapping;
}

/**
 * A mapping store beneath `root`.
 *
 * `root` is the store's own directory, versioned separately from ACPX's
 * records so that clearing one never silently clears the other.
 */
export function createNativeSessionMappingStore(root: string): NativeSessionMappingStore {
  return {
    *read(key) {
      const mapping = yield* readMapping(fileFor(root, key));
      if (mapping && !describesSession(mapping, key)) {
        // The file is named by a digest of the key, so its contents naming a
        // different session means the record was moved, hand-edited, or
        // written under another naming scheme. Returning it would hand this
        // session another one's identity — the exact substitution the whole
        // arrangement exists to prevent — and it would do so silently,
        // because a well-formed record from the expected filename looks
        // like an answer.
        throw new NativeSessionConflict(
          `the retained native session mapping describes a different session`,
        );
      }
      return mapping;
    },

    *create(mapping) {
      yield* until(mkdir(root, { recursive: true, mode: 0o700 }));
      const file = fileFor(root, mapping);

      // Scoped so the candidate is gone by the time this returns. `ensure`
      // alone would register the cleanup in the caller's scope, leaving the
      // half-published name visible in the store for as long as the caller
      // runs — which is exactly when a reader is most likely to look.
      return yield* scoped(function* (): Operation<NativeSessionMapping> {
        // The candidate is written in the destination directory so that
        // publication is a link within one filesystem — across filesystems
        // there is no atomic publish, only a copy that can be observed
        // half-done.
        const candidate = `${file}.${randomUUID()}.candidate`;
        yield* ensure(() => until(rm(candidate, { force: true })));
        yield* until(writeFile(candidate, serialize(mapping), { mode: 0o600 }));

        const published = yield* until(
          link(candidate, file).then(
            () => true,
            (cause: unknown) => {
              if (isRecord(cause) && cause.code === "EEXIST") {
                return false;
              }
              throw cause;
            },
          ),
        );
        if (published) {
          return mapping;
        }

        // Someone else got there first. Their record is authoritative, and the
        // only question is whether it says the same thing — an equal one is
        // adopted, a different one is a conflict rather than something to
        // overwrite, because whatever allocated it may already have used it.
        const winner = yield* readMapping(file);
        if (winner && !describesSession(winner, mapping)) {
          throw new NativeSessionConflict(
            `the retained native session mapping describes a different session`,
          );
        }
        if (!winner) {
          throw new NativeSessionConflict(
            "the native session mapping disappeared while it was being created",
          );
        }
        if (!sameNativeSessionMapping(winner, mapping)) {
          throw new NativeSessionConflict(
            `a different native session is already retained for ${mapping.agent}`,
          );
        }
        return winner;
      });
    },
  };
}

const ROUTE_SCHEMA = "session-route.v1";

/**
 * How one logical session was constructed.
 *
 * This is the cross-runtime construction fence. A logical session is claimed
 * for exactly one path before anything is established on it, so a native launch
 * and an ACP ensure racing for the same name cannot each conclude they chose.
 * The claim is published atomically and never converts: a route that could
 * change would leave both owners believing they had decided.
 *
 * `acp-first` carries nothing. It says only that ACP owns construction, and
 * carrying identity or a binding there would describe a session it does not
 * have.
 */
export interface AcpFirstRoute extends NativeSessionKey {
  schema: typeof ROUTE_SCHEMA;
  route: "acp-first";
}

/** A session whose identity XMD allocated and a native UI created. */
export interface ClientNativeRoute extends NativeSessionKey {
  schema: typeof ROUTE_SCHEMA;
  route: "client-native";
  nativeSessionId: string;
  identityProvenance: "client-allocated";
  instructionsDigest: string;
  launcher: string;
  executableBinding: ExecutableBuildBindingV1;
  /**
   * Present when this route was read from the pre-amendment mapping shape.
   *
   * Not retained and not part of the record: it says where the reading came
   * from, which is what tells the provider that whatever ACPX holds under the
   * same key was written before routes existed and has to be reconciled
   * before anything acts on it.
   */
  origin?: typeof SCHEMA;
}

export type SessionRoute = AcpFirstRoute | ClientNativeRoute;

export interface SessionRouteStore {
  read(key: NativeSessionKey): Operation<SessionRoute | undefined>;
  /**
   * Publish `route` unless one already exists, and return whichever is now
   * authoritative. A caller adopts the result rather than assuming its own
   * candidate won.
   */
  publish(route: SessionRoute): Operation<SessionRoute>;
}

/** The file one logical session's route lives in. */
export function routeFileFor(root: string, key: NativeSessionKey): string {
  return fileFor(root, key);
}

function serializeRoute(route: SessionRoute): string {
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
    payload.executableBinding = route.executableBinding;
  }
  return `${JSON.stringify(payload, null, 2)}\n`;
}

function routeKeyOf(value: Record<string, unknown>): NativeSessionKey | undefined {
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
  return { provider, agent, sessionKey };
}

/**
 * Read a route strictly.
 *
 * The pre-amendment `native-session-mapping.v1` shape is recognized as the
 * client-native route it always described — recognized, not migrated. A reader
 * that rewrote it would be writing state it does not own, on behalf of a
 * process that may be doing the same thing at the same moment.
 *
 * Nothing else is inferred. An unknown schema, an unknown variant, or a variant
 * carrying fields it has no business holding is a route this build cannot
 * reason about, and a route it cannot reason about is one it must not act on.
 */
export function parseSessionRoute(value: unknown): SessionRoute | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (value.schema === SCHEMA) {
    const mapping = parseNativeSessionMapping(value);
    if (!mapping || mapping.identityProvenance !== "client-allocated") {
      return undefined;
    }
    const { executableBinding } = mapping;
    if (!executableBinding) {
      return undefined;
    }
    return {
      schema: ROUTE_SCHEMA,
      route: "client-native",
      provider: mapping.provider,
      agent: mapping.agent,
      sessionKey: mapping.sessionKey,
      nativeSessionId: mapping.nativeSessionId,
      identityProvenance: "client-allocated",
      instructionsDigest: mapping.instructionsDigest,
      launcher: mapping.launcher,
      executableBinding,
      origin: SCHEMA,
    };
  }
  if (value.schema !== ROUTE_SCHEMA) {
    return undefined;
  }
  const key = routeKeyOf(value);
  if (!key) {
    return undefined;
  }
  if (value.route === "acp-first") {
    // Nothing else may be present: a claim that carries an identity is
    // describing a session ACP-first construction never created.
    for (const field of [
      "nativeSessionId",
      "executableBinding",
      "launcher",
      "instructionsDigest",
    ]) {
      if (value[field] !== undefined) {
        return undefined;
      }
    }
    return { schema: ROUTE_SCHEMA, route: "acp-first", ...key };
  }
  if (value.route !== "client-native") {
    return undefined;
  }
  const { nativeSessionId, instructionsDigest, launcher } = value;
  if (typeof nativeSessionId !== "string" || nativeSessionId.length === 0) {
    return undefined;
  }
  if (typeof instructionsDigest !== "string" || instructionsDigest.length === 0) {
    return undefined;
  }
  if (typeof launcher !== "string" || launcher.length === 0) {
    return undefined;
  }
  if (value.identityProvenance !== "client-allocated") {
    return undefined;
  }
  const binding = parseBinding(value.executableBinding);
  if (!binding) {
    return undefined;
  }
  return {
    schema: ROUTE_SCHEMA,
    route: "client-native",
    ...key,
    nativeSessionId,
    identityProvenance: "client-allocated",
    instructionsDigest,
    launcher,
    executableBinding: binding,
  };
}

/** Whether two routes claim the same construction under the same terms. */
export function sameSessionRoute(left: SessionRoute, right: SessionRoute): boolean {
  if (
    left.route !== right.route ||
    left.provider !== right.provider ||
    left.agent !== right.agent ||
    left.sessionKey !== right.sessionKey
  ) {
    return false;
  }
  if (left.route === "acp-first" || right.route === "acp-first") {
    return true;
  }
  return (
    left.nativeSessionId === right.nativeSessionId &&
    left.identityProvenance === right.identityProvenance &&
    left.instructionsDigest === right.instructionsDigest &&
    left.launcher === right.launcher &&
    sameExecutableBuild(left.executableBinding, right.executableBinding)
  );
}

function* readRoute(file: string, key: NativeSessionKey): Operation<SessionRoute | undefined> {
  const text = yield* until(
    readFile(file, "utf8").catch((cause: unknown) => {
      if (isRecord(cause) && cause.code === "ENOENT") {
        return undefined;
      }
      throw cause;
    }),
  );
  if (text === undefined) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new NativeSessionConflict("the retained session route is not readable");
  }
  const route = parseSessionRoute(parsed);
  if (!route) {
    throw new NativeSessionConflict("the retained session route is not valid");
  }
  // The file is named by a digest of the key, so contents naming another
  // session mean the record was moved or rewritten. Answering with it would
  // route this session down another one's path.
  if (!describesSession(route, key)) {
    throw new NativeSessionConflict("the retained session route describes a different session");
  }
  return route;
}

/**
 * A route store beneath `root`.
 *
 * Publication is the same hard link the identity mapping uses: the filesystem
 * refuses rather than replaces, so exactly one claim wins and every other
 * caller learns what it lost to.
 */
export function createSessionRouteStore(root: string): SessionRouteStore {
  return {
    *read(key) {
      return yield* readRoute(fileFor(root, key), key);
    },

    *publish(route) {
      yield* until(mkdir(root, { recursive: true, mode: 0o700 }));
      const file = fileFor(root, route);

      return yield* scoped(function* (): Operation<SessionRoute> {
        const candidate = `${file}.${randomUUID()}.candidate`;
        yield* ensure(() => until(rm(candidate, { force: true })));
        yield* until(writeFile(candidate, serializeRoute(route), { mode: 0o600 }));

        const published = yield* until(
          link(candidate, file).then(
            () => true,
            (cause: unknown) => {
              if (isRecord(cause) && cause.code === "EEXIST") {
                return false;
              }
              throw cause;
            },
          ),
        );
        if (published) {
          return route;
        }

        const winner = yield* readRoute(file, route);
        if (!winner) {
          throw new NativeSessionConflict(
            "the session route disappeared while it was being published",
          );
        }
        if (!sameSessionRoute(winner, route)) {
          throw new NativeSessionConflict(
            winner.route === route.route
              ? `a different ${winner.route} session is already retained for ${route.agent}`
              : `session "${route.sessionKey}" is already retained as ${winner.route}, and a ` +
                  `route never converts`,
          );
        }
        return winner;
      });
    },
  };
}

/**
 * A route store held in memory, for a provider whose sessions live and die
 * with it.
 *
 * `<TestAgent>` is the case: its ACPX records are in memory already, so a
 * file-backed route store would be the one piece of a scenario that outlived
 * the scenario — writing claims into the coordinator namespace real
 * invocations share. Publication is create-once here too, and a route is kept
 * only in the form the file store would have accepted, so a record this
 * retains is one that store could return.
 *
 * What it does not provide is cross-process exclusivity, because there is no
 * second process to exclude. A provider that coordinates with other processes
 * takes the file-backed store.
 */
export function createMemorySessionRouteStore(): SessionRouteStore {
  const retained = new Map<string, SessionRoute>();
  const nameOf = (key: NativeSessionKey) =>
    JSON.stringify([key.provider, key.agent, key.sessionKey]);

  /** Keep only what a reader could have parsed out of the file store. */
  function retain(route: SessionRoute): SessionRoute {
    const parsed = parseSessionRoute(JSON.parse(serializeRoute(route)));
    if (!parsed) {
      throw new NativeSessionConflict("the session route is not valid");
    }
    return parsed;
  }

  return {
    // deno-lint-ignore require-yield
    *read(key) {
      const route = retained.get(nameOf(key));
      if (route && !describesSession(route, key)) {
        throw new NativeSessionConflict("the retained session route describes a different session");
      }
      return route;
    },

    // deno-lint-ignore require-yield
    *publish(route) {
      const name = nameOf(route);
      const winner = retained.get(name);
      if (!winner) {
        const published = retain(route);
        retained.set(name, published);
        return published;
      }
      if (!sameSessionRoute(winner, route)) {
        throw new NativeSessionConflict(
          winner.route === route.route
            ? `a different ${winner.route} session is already retained for ${route.agent}`
            : `session "${route.sessionKey}" is already retained as ${winner.route}, and a ` +
                `route never converts`,
        );
      }
      return winner;
    },
  };
}
