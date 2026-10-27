/**
 * A separate process that takes session ownership and then waits to be killed.
 *
 * The crash case cannot be simulated in-process: what is under test is that the
 * kernel releases the advisory lock when the holder dies while the durable
 * record it wrote stays active. Nothing in a surviving process observes that
 * death, so this is a real child and the test really kills it.
 *
 * It lives in the repository rather than a temporary directory because it
 * imports workspace packages, which resolve only inside the project.
 */
import { main, suspend, until } from "effection";
import {
  createDenoAgentSessionCoordinator,
  createDenoAgentSessionHost,
  agentSessionKeyDigest,
} from "@executablemd/runtime";

const [root, provider, agent, sessionKey, expectedRevision] = Deno.args;

await main(function* () {
  if (expectedRevision) {
    const host = createDenoAgentSessionHost(root!);
    if (!host) {
      throw new Error("fixture host unavailable");
    }
    console.log("recovery:ready");
    const reader = Deno.stdin.readable.getReader();
    try {
      yield* until(reader.read());
    } finally {
      reader.releaseLock();
    }
    const result = yield* host.ownershipAdministration.forceRecoverOwnership({
      keyDigest: agentSessionKeyDigest({
        provider: provider!,
        agent: agent!,
        sessionKey: sessionKey!,
      }),
      expectedRevision,
      force: true,
    });
    console.log(
      JSON.stringify(
        result.ok
          ? { ok: true, receipt: result.value }
          : { ok: false, code: Reflect.get(result.error, "code") },
      ),
    );
    return;
  }
  const coordinator = createDenoAgentSessionCoordinator(root!);
  if (!coordinator) {
    console.log("owner:unavailable");
    return;
  }
  const outcome = yield* coordinator.coordinate(
    { provider: provider!, agent: agent!, sessionKey: sessionKey! },
    { kind: "native-launch", operationId: "00000000-0000-4000-8000-000000000001" },
    function* () {
      // Announced from inside the body, so the parent contends against
      // ownership that exists rather than racing process startup.
      console.log("owner:active");
      yield* suspend();
    },
  );
  console.log(outcome.ok ? "owner:ok" : `owner:${outcome.error.name}`);
});
