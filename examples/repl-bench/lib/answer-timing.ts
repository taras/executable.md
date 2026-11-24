import { appendFileSync } from "node:fs";

export const answerLabel = "[answer sidekick]";
export const answerTimingFile = "sidekick-answer-timing.jsonl";
export const answerTimingEnvironment = "XMD_REPL_BENCH_ANSWER_TIMING";
export const macSystemLibrary = "/usr/lib/libSystem.B.dylib";
export const monotonicRaw = 4;

type Event =
  | { event: "wait-start"; attempt: number; timeoutMs: number }
  | { event: "wait-expired" | "wait-matched"; attempt: number }
  | { event: "pty-consumed"; receivedNs: string }
  | {
      event: "registered" | "frame-write-start" | "frame-write-end";
      conversation: string;
      response: string;
      turn: number;
    };

export function answerTiming(path: string, clock: () => bigint) {
  return (event: Event) => {
    const row = JSON.stringify({ ...event, ns: clock().toString() });
    // An event must survive cancellation or a forced stop between these boundaries.
    // oxlint-disable-next-line local/no-sync-filesystem
    appendFileSync(path, `${row}\n`);
  };
}
