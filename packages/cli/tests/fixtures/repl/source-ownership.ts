import { collect, Elicitation, inlineSource } from "@executablemd/core";
import { executeInstalled } from "@executablemd/core/host";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { DurableEvent } from "@executablemd/durable-streams";
import { scoped } from "effection";
import type { Operation } from "effection";
import { fileURLToPath } from "node:url";

export const OWNER_DIRECTORY = fileURLToPath(new URL("./", import.meta.url));
export const OWNER_ENTRY = [
  '<OwnerWrapper input="first" as="first" />',
  '<OwnerWrapper input="second" as="second" />',
  "{first}/{second}",
].join("\n");
export const OWNER_FIELD = "executablemd.source-owner";

export function ownerRun(
  source: string = OWNER_ENTRY,
  stream: InMemoryStream = new InMemoryStream(),
  answer: (message: string) => Operation<string> = function* (message) {
    return message.trim();
  },
): Operation<{ output: string; events: DurableEvent[] }> {
  return scoped(function* () {
    yield* Elicitation.around({
      *elicit([request]) {
        return yield* answer(request.message);
      },
    });
    const execution = yield* executeInstalled(
      { ...inlineSource(source), stream, includes: [OWNER_DIRECTORY] },
      [],
    );
    const output = String(yield* collect(execution));
    return { output, events: yield* stream.readAll() };
  });
}

export function legacyOwners(events: readonly DurableEvent[]): DurableEvent[] {
  return events.map((event) => {
    if (event.type !== "yield") {
      return event;
    }
    const { [OWNER_FIELD]: _owner, ...description } = event.description;
    return { ...event, description };
  });
}
