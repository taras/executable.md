import { ensure, race, scoped, spawn, withResolvers } from "effection";
import type { Operation, Task } from "effection";
import { z } from "zod";
import { childAddressPath } from "../headless/host.ts";
import type { StandardInputReader } from "../standard-input.ts";
import {
  Envelope,
  MAX_FRAME,
  MAX_TEXT,
  Reply,
  SidekickTransport,
  SubmitRecord,
} from "./protocol.ts";
import type { SubmissionReference, Wire } from "./protocol.ts";

export function isReplSubmit(args: readonly string[]): boolean {
  return args[0] === "repl" && args[1] === "submit";
}

export function submitStatus(record: SubmitRecord, failed = false): number {
  if (failed || (record.kind === "finished" && record.outcome === "failed")) {
    return 1;
  }
  if (record.kind === "unavailable") {
    return 2;
  }
  return record.kind === "finished" ? (record.outcome === "interrupted" ? 130 : 0) : 2;
}

export function* sourceFrames(source: string, submit = 1) {
  let id = 2;
  let text = "";
  let bytes = 0;
  let encoded = 0;
  const encoder = new TextEncoder();
  const frame = (done: boolean) => ({
    id,
    request: { method: "submit-source", submit, text, done },
  });
  const overheadOf = () =>
    encoder.encode(
      JSON.stringify({ id, request: { method: "submit-source", submit, text: "", done: false } }),
    ).length;
  let overhead = overheadOf();
  for (const point of source) {
    const size = encoder.encode(point).length;
    const escaped = encoder.encode(JSON.stringify(point)).length - 2;
    if (bytes + size > MAX_TEXT || overhead + encoded + escaped > MAX_FRAME) {
      yield Envelope.parse(frame(false));
      id += 1;
      overhead = overheadOf();
      text = "";
      bytes = 0;
      encoded = 0;
    }
    text += point;
    bytes += size;
    encoded += escaped;
  }
  yield Envelope.parse(frame(true));
}

const interruptedBeforeAdmission: SubmitRecord = {
  kind: "finished",
  submission: null,
  joined: true,
  outcome: "interrupted",
  result: null,
  error: null,
  journal: null,
};

export function runReplSubmit(
  args: readonly string[],
  readInput: StandardInputReader,
  interrupted: Operation<void>,
  write: (record: SubmitRecord) => Operation<void>,
  diagnostic: (message: string) => void,
): Operation<number> {
  return scoped(function* () {
    let sessionId: string;
    try {
      if (args.length !== 5 || !isReplSubmit(args) || args[2] !== "--attach" || args[4] !== "-") {
        throw new Error(
          "Use xmd repl submit --attach SESSION_ID - with one complete program on stdin.",
        );
      }
      sessionId = z.string().uuid().parse(args[3]);
    } catch (error) {
      diagnostic(
        error instanceof Error ? error.message : "Direct submission arguments were refused.",
      );
      return 1;
    }
    let finished = false;
    let interaction = false;
    let reference: SubmissionReference | null = null;
    let wire: Wire | undefined;
    let interruptRequested = false;
    let worker: Task<void> | undefined;
    const settled = withResolvers<number>();
    const terminal = withResolvers<SubmitRecord>();
    const pending = new Map<number, ReturnType<typeof withResolvers<void>>>();
    let notification = withResolvers<void>();
    let admission: SubmitRecord | undefined;
    let latest: SubmitRecord | undefined;
    let final: SubmitRecord | undefined;
    let finalFailure: Error | undefined;
    let knownFailure = false;
    const notify = () => notification.resolve();
    function* send(frame: z.infer<typeof Envelope>): Operation<void> {
      const credit = withResolvers<void>();
      pending.set(frame.id, credit);
      try {
        if (wire === undefined) {
          throw new Error("The direct connection is unavailable.");
        }
        yield* wire.send(frame);
        yield* race([
          credit.operation,
          (function* () {
            yield* terminal.operation;
          })(),
        ]);
      } finally {
        pending.delete(frame.id);
      }
    }
    yield* ensure(() => {
      pending.clear();
    });
    worker = yield* spawn(function* () {
      let status = 1;
      try {
        yield* scoped(function* () {
          const source = yield* readInput();
          if (!source.ok) {
            throw new Error(
              "xmd repl submit could not read a complete program from standard input",
            );
          }
          const path = yield* childAddressPath(sessionId);
          const host = yield* SidekickTransport.expect();
          const connection = yield* host.connect(path);
          wire = connection.wire;
          const descriptor = connection.descriptor;
          if (descriptor.owner !== sessionId) {
            throw new Error("The exact child descriptor names a different owner.");
          }
          yield* wire.send({ id: 0, request: { method: "hello", descriptor } });
          const hello = Reply.parse(yield* wire.receive());
          if (
            hello.id !== 0 ||
            hello.kind !== "value" ||
            JSON.stringify(hello.value) !== JSON.stringify(descriptor)
          ) {
            throw new Error("The exact child descriptor handshake was refused.");
          }
          yield* spawn(function* () {
            try {
              while (true) {
                const reply = Reply.parse(yield* connection.wire.receive());
                if (reply.id !== 1) {
                  const waiter = pending.get(reply.id);
                  if (waiter === undefined) {
                    throw new Error("The direct reply names no outstanding request.");
                  }
                  if (reply.kind === "error") {
                    waiter.reject(new Error(reply.error));
                  } else if (reply.kind === "value") {
                    waiter.resolve();
                  } else {
                    throw new Error("Source and interrupt replies grant no progress updates.");
                  }
                  continue;
                }
                if (reply.kind === "error") {
                  if (reply.facts !== undefined) {
                    const record = SubmitRecord.parse(reply.facts);
                    if (
                      record.kind !== "unavailable" ||
                      record.submission === null ||
                      record.submission.sessionId !== sessionId ||
                      record.submission.execution !== descriptor.execution ||
                      (reference !== null &&
                        JSON.stringify(reference) !== JSON.stringify(record.submission))
                    ) {
                      throw new Error("The joined failure delivery names another submission.");
                    }
                    reference = record.submission;
                    knownFailure = true;
                    final = record;
                    terminal.resolve(record);
                    notify();
                    return;
                  }
                  finalFailure = new Error(reply.error);
                  terminal.reject(finalFailure);
                  notify();
                  return;
                }
                const record = SubmitRecord.parse(reply.value);
                if (record.submission !== null) {
                  if (
                    record.submission.sessionId !== sessionId ||
                    record.submission.execution !== descriptor.execution ||
                    (reference !== null &&
                      JSON.stringify(reference) !== JSON.stringify(record.submission))
                  ) {
                    throw new Error("The direct record names another exact submission.");
                  }
                  reference = record.submission;
                }
                if (reply.kind === "value") {
                  if (record.kind !== "finished" && record.kind !== "unavailable") {
                    throw new Error("The direct final reply has no joined ending.");
                  }
                  final = record;
                  knownFailure = record.kind === "finished" && record.outcome === "failed";
                  terminal.resolve(record);
                  notify();
                  return;
                }
                if (record.kind === "admitted") {
                  if (admission !== undefined) {
                    throw new Error("The direct request admitted more than once.");
                  }
                  admission = record;
                } else if (record.kind === "progress" && admission !== undefined) {
                  latest = record;
                } else {
                  throw new Error("The direct update preceded admission or supplied an ending.");
                }
                notify();
              }
            } catch {
              final = {
                kind: "unavailable",
                submission: reference,
                reason: "The connection ended before complete joined evidence arrived.",
              };
              terminal.resolve(final);
              notify();
            }
          });
          interaction = true;
          yield* wire.send({ id: 1, request: { method: "submit" } });
          yield* spawn(function* () {
            try {
              for (const frame of sourceFrames(source.value)) {
                if (interruptRequested || final !== undefined || finalFailure !== undefined) {
                  break;
                }
                yield* send(frame);
              }
            } catch {
              if (!interruptRequested && finalFailure === undefined && final === undefined) {
                final = {
                  kind: "unavailable",
                  submission: reference,
                  reason: "The source transfer ended without joined evidence.",
                };
                terminal.resolve(final);
                notify();
              }
            }
          });
          let admittedWritten = false;
          while (true) {
            notification = withResolvers<void>();
            if (!admittedWritten && admission !== undefined) {
              admittedWritten = true;
              yield* write(admission);
            }
            const snapshot = latest;
            latest = undefined;
            if (snapshot !== undefined) {
              yield* write(snapshot);
            }
            if (finalFailure !== undefined) {
              throw finalFailure;
            }
            if (final !== undefined) {
              status = submitStatus(final, knownFailure);
              return;
            }
            yield* notification.operation;
          }
        });
        if (final !== undefined) {
          yield* write(final);
        }
      } catch (error) {
        if (interaction && finalFailure === undefined) {
          yield* write({
            kind: "unavailable",
            submission: reference,
            reason: "The submission ended without complete joined evidence.",
          });
          status = knownFailure ? 1 : 2;
        } else {
          diagnostic(error instanceof Error ? error.message : "Direct submission was refused.");
          status = 1;
        }
      } finally {
        finished = true;
        if (!(interruptRequested && !interaction)) {
          settled.resolve(status);
        }
      }
    });
    yield* spawn(function* () {
      yield* interrupted;
      if (finished || interruptRequested) {
        return;
      }
      interruptRequested = true;
      if (!interaction) {
        yield* worker?.halt();
        yield* write(interruptedBeforeAdmission);
        settled.resolve(130);
      } else {
        try {
          yield* send({
            id: Number.MAX_SAFE_INTEGER,
            request: { method: "submit-interrupt", submit: 1 },
          });
        } catch {
          // A late refusal cannot replace the exact entry's natural completion.
        }
      }
    });
    const status = yield* settled.operation;
    if (interruptRequested && !interaction) {
      return 130;
    }
    return status;
  });
}
