import { exists } from "@effectionx/fs";
import type { AgentSessionKey } from "@executablemd/runtime";
import { agentSessionKeyDigest } from "@executablemd/runtime";
import { until } from "effection";
import type { Operation } from "effection";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { AcpSessionRecord } from "../../src/acpx-runtime.ts";
import type { EmbeddedAdapters } from "../../src/adapter-snapshots.ts";
import { deriveSessionKey } from "../../src/session-key.ts";
import type { AgentSessionRouteStore, AgentSessionRouteV2 } from "../../src/session-route.ts";
import { createAcpxSessionStore } from "../../src/session-store.ts";

export function nativeUiInvocations<T extends { argv: string[] }>(invocations: T[]): T[] {
  return invocations.filter(
    ({ argv }) =>
      !argv.some((arg) => ["--print", "-p", "--input-format", "--output-format"].includes(arg)) &&
      ((argv[0] === "--session-id" && argv.includes("--system-prompt-file")) ||
        (argv[0] === "--resume" && !argv.includes("--session-id"))),
  );
}

export function claudeKeyPaths(root: string, agent: string, sessionKey: string): string[] {
  const digest = agentSessionKeyDigest({ provider: "acpx", agent, sessionKey });
  return [
    join(root, "routes", digest + ".json"),
    join(root, "ownership", digest + ".json"),
    join(root, "leases", digest + ".lease"),
  ];
}

export function claudeRouteKey(adapters: EmbeddedAdapters, project: string): AgentSessionKey {
  const agent = adapters.command("claude");
  return { provider: "acpx", agent, sessionKey: deriveSessionKey(agent, project, "implementer") };
}

export function* prepareAbsentRoute(
  store: AgentSessionRouteStore,
  key: AgentSessionKey,
  nativeSessionId: string,
): Operation<AgentSessionRouteV2> {
  const { agent, sessionKey } = key;
  const route: AgentSessionRouteV2 = {
    schema: "session-route.v2",
    route: "client-native",
    provider: "acpx",
    agent,
    sessionKey,
    nativeSessionId,
    identityProvenance: "client-allocated",
    instructionsDigest: createHash("sha256").update(sessionKey).digest("hex"),
    launcher: "claude",
    executableBinding: {
      schema: "executable-build.v1",
      reportedVersion: "2.1.241 (Claude Code)",
      executableDigest: { algorithm: "sha256", value: "c".repeat(64) },
    },
  };
  yield* store.publish(route);
  const read = yield* store.read({ provider: "acpx", agent, sessionKey });
  if (
    read?.schema !== "session-route.v2" ||
    read.nativeSessionId !== nativeSessionId ||
    read.instructionsDigest !== route.instructionsDigest ||
    read.launcher !== "claude" ||
    read.executableBinding.reportedVersion !== route.executableBinding.reportedVersion ||
    read.executableBinding.executableDigest.value !== route.executableBinding.executableDigest.value
  ) {
    throw new Error(
      "the product-addressed route does not contain the absent identity's historical record",
    );
  }
  return read;
}

export function* readProofArrangement(
  root: string,
  sessionKey: string,
): Operation<AcpSessionRecord | undefined> {
  const record = yield* until(createAcpxSessionStore(root).load(sessionKey));
  if (
    !record &&
    (yield* exists(join(root, "sessions", encodeURIComponent(sessionKey) + ".json")))
  ) {
    throw new Error("the proof arrangement could not be read");
  }
  return record;
}

/** ACPX persists the User submission before connecting or writing session/prompt. */
export function* submittedModelTurns(root: string, sessionKey: string): Operation<number> {
  const record = yield* readProofArrangement(root, sessionKey);
  return (
    record?.messages.filter(
      (message) => typeof message === "object" && message !== null && "User" in message,
    ).length ?? 0
  );
}
