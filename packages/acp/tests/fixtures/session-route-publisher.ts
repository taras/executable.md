/**
 * One other process publishing one route.
 *
 * The create-once race is a claim about two processes, and only two processes
 * can make it: one runtime racing itself shares a filesystem cache and a
 * scheduler, and would agree with a broken implementation as readily as a
 * working one.
 *
 * Writes the winner it observed to stdout as JSON, so the parent can prove both
 * processes adopted the same one.
 */
import { main, sleep, until } from "effection";
import { stat } from "node:fs/promises";
import { createDenoSessionRouteStore } from "../../src/session-route.ts";
import type { AgentSessionRouteV1 } from "../../src/session-route.ts";

await main(function* () {
  const [root, sessionKey, nativeSessionId, ready] = Deno.args;

  const store = createDenoSessionRouteStore(root!);
  if (!store) {
    throw new Error("this host keeps no durable routes");
  }

  const candidate: AgentSessionRouteV1 = {
    schema: "session-route.v1",
    route: "client-native",
    provider: "acpx",
    agent: "claude-cmd",
    sessionKey: sessionKey!,
    nativeSessionId: nativeSessionId!,
    identityProvenance: "client-allocated",
    instructionsDigest: "b".repeat(64),
    launcher: "claude",
    executableBinding: {
      schema: "executable-build.v1",
      reportedVersion: "2.1.235",
      executableDigest: { algorithm: "sha256", value: "c".repeat(64) },
    },
  };

  // The parent starts both children and then creates this file, so neither one
  // reaches `publish` before the other exists.
  while (
    !(yield* until(
      stat(ready!).then(
        () => true,
        () => false,
      ),
    ))
  ) {
    yield* sleep(5);
  }

  const winner = yield* store.publish(candidate);
  console.log(JSON.stringify(winner));
});
