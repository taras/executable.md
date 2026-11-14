import { ensureDir, exists, readTextFile, writeTextFile } from "@effectionx/fs";
import { cwd } from "@executablemd/runtime";
import { runShell } from "@executablemd/test-support/launch";
import { ensure, race, scoped, spawn } from "effection";
import { z } from "zod";
import { reviewCall, reviewProcessEnv, waitForFile } from "./ReviewDispatch.ts";

export const props = {
  type: "object",
  properties: {
    command: { type: "string" },
    directory: { type: "string" },
    attempt: { type: "string" },
    revision: { type: "string" },
  },
  required: ["command", "directory", "attempt", "revision"],
  additionalProperties: false,
};

const input = z.strictObject({
  command: z.string(),
  directory: z.string().startsWith("/"),
  attempt: z.string().startsWith("/"),
  revision: z.string(),
});

export default function* ReviewOverlap(value: unknown) {
  const { command, directory, attempt, revision } = input.parse(value);
  const evidence = `${directory}/overlap`;
  const replacement = `${attempt}/replacement`;
  const release = `${evidence}/release`;
  const repository = yield* cwd();
  yield* ensureDir(evidence);

  const review = (actor: "winner" | "contender" | "later", timeout: number) =>
    runShell(`exec ${command} --props-action review`, {
      cwd: repository,
      env: { [reviewProcessEnv]: actor },
      inheritEnv: true,
      timeout,
    }).join();

  const held = function* () {
    return (
      (yield* exists(`${replacement}/transition.json`)) &&
      (yield* exists(`${replacement}/assignment.json`)) &&
      !(yield* exists(`${replacement}/outcome.json`)) &&
      !(yield* exists(`${replacement}/execution.json`))
    );
  };

  const { winner, contender, wasHeld } = yield* scoped(function* () {
    const first = yield* spawn(() => review("winner", 90_000));
    let released = false;
    yield* ensure(function* () {
      if (!released) {
        yield* writeTextFile(release, "");
      }
      yield* first;
    });

    const exitedEarly = function* () {
      const result = yield* first;
      throw new Error(
        `Winner exited before replacement reviewer entry (${result.code}): ${result.stderr}`,
      );
    };
    const ready = yield* race([waitForFile(`${evidence}/ready`, 30_000), exitedEarly()]);
    if (ready.timeout || !(yield* held())) {
      throw new Error("The winner did not reach the reserved replacement reviewer and stay there.");
    }
    const call = reviewCall.parse(JSON.parse(yield* readTextFile(`${evidence}/winner-1.json`)));
    if (call.position !== 1 || call.revision !== revision || !call.prompted) {
      throw new Error(`The winner reached an unexpected review: ${JSON.stringify(call)}`);
    }

    const contender = yield* review("contender", 30_000);
    const wasHeld = yield* held();
    yield* writeTextFile(release, "");
    released = true;
    return { contender, wasHeld, winner: yield* first };
  });

  const dispatches = (actor: "winner" | "contender" | "later") =>
    scoped(function* () {
      const positions = [];
      for (const position of [0, 1]) {
        if (yield* exists(`${evidence}/${actor}-${position}.json`)) {
          positions.push(position);
        }
      }
      return positions;
    });
  const contenderCalls = yield* dispatches("contender");
  if (!wasHeld || contenderCalls.length !== 0) {
    throw new Error(
      `Contender dispatches ${JSON.stringify(contenderCalls)} while winner was held: ${wasHeld}. ${contender.stderr}`,
    );
  }
  if (
    contender.code !== 1 ||
    !contender.stderr.includes(
      "The next action is reconcile_original_review; do not start another review.",
    )
  ) {
    throw new Error(
      `Unexpected overlapping review result (${contender.code}): ${contender.stderr} ${contender.stdout}`,
    );
  }
  const winnerCalls = yield* dispatches("winner");
  if (winner.code !== 0 || winnerCalls.length !== 1 || winnerCalls[0] !== 1) {
    throw new Error(
      `Winner exited ${winner.code} with dispatches ${JSON.stringify(winnerCalls)}: ${winner.stderr} ${winner.stdout}`,
    );
  }

  const later = yield* review("later", 30_000);
  const laterCalls = yield* dispatches("later");
  if (
    later.code !== 1 ||
    laterCalls.length !== 0 ||
    !later.stderr.includes(
      "The next action is await_authorized_merge; do not start another review.",
    )
  ) {
    throw new Error(
      `Unexpected later review result (${later.code}) with dispatches ${JSON.stringify(laterCalls)}: ${later.stderr} ${later.stdout}`,
    );
  }
}
