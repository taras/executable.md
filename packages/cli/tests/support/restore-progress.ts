import type { Operation } from "effection";
import { INLINE_SOURCE_PATH } from "@executablemd/core";
import { serializeDurableEvent } from "@executablemd/durable-streams";
import type { DurableEvent } from "@executablemd/durable-streams";
import { readTextFile } from "@effectionx/fs";
import { pairedLocation } from "../../src/repl/sidekick/history.ts";
import type { PairedLocation } from "../../src/repl/sidekick/history.ts";
import type { MountedHost } from "./mounted-repl.ts";

const CHAT_OUTPUT = "Saved Sidekick reply witness.";

export interface RetainedRestoreFixture {
  readonly id: string;
  readonly files: PairedLocation;
  readonly entries: string;
  readonly sidekick: string;
}

export function* savedRestoreFixture(
  host: Pick<MountedHost, "root" | "repository">,
  rounds: number,
): Operation<RetainedRestoreFixture> {
  const execution = yield* host.repository.create();
  for (let round = 1; round <= rounds; round += 1) {
    yield* execution.stream.append({
      type: "yield",
      coroutineId: "root",
      description: { type: "import_component", name: "__root__" },
      result: {
        status: "ok",
        value: {
          kind: "repository",
          path: INLINE_SOURCE_PATH,
          content: `Round ${round} source.`,
        },
      },
    });
    yield* execution.stream.append(savedClose(round));
  }
  if (rounds > 0 && execution.chat.form === "paired") {
    const conversation = "restore-chat";
    const agent = "scribe";
    const prompt: DurableEvent = {
      type: "yield",
      coroutineId: "root",
      description: { type: "agent_prompt", name: "turn:1", input: "A saved request." },
      result: {
        status: "ok",
        value: {
          sequence: 0,
          agent,
          sessionKey: "stub:default",
          status: "completed",
          text: CHAT_OUTPUT,
        },
      },
    };
    yield* execution.chat.writer.append({
      kind: "conversation",
      conversation,
      agent,
      phase: "prepared",
    });
    yield* execution.chat.writer.append({
      kind: "conversation",
      conversation,
      agent,
      phase: "activated",
    });
    yield* execution.chat.writer.append({
      kind: "event",
      conversation,
      sequence: 0,
      event: serializeDurableEvent(prompt),
    });
    yield* execution.chat.writer.append({
      kind: "response",
      conversation,
      turn: 1,
      response: "restore-reply",
      outcome: { status: "ok" },
      hasOutput: true,
      output: CHAT_OUTPUT,
    });
  }
  const files = pairedLocation(host.root, execution.id);
  return {
    id: execution.id,
    files,
    entries: yield* readTextFile(files.entries),
    sidekick: yield* readTextFile(files.sidekick),
  };
}

function savedClose(round: number, invalid = false): DurableEvent {
  return {
    type: "close",
    coroutineId: "root",
    result: {
      status: "ok",
      value: {
        status: "ok",
        output: `Saved round ${round} witness.`,
        bindings: invalid ? { "invalid name": 1 } : {},
      },
    },
  };
}

export function invalidRestoreEntries(fixture: RetainedRestoreFixture): string {
  return fixture.entries.replace(
    serializeDurableEvent(savedClose(119)),
    serializeDurableEvent(savedClose(119, true)),
  );
}
