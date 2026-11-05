import { resolveJournalMaxBytes } from "../repl/sidekick/journal-policy.ts";
import { scoped } from "effection";
import type { Operation } from "effection";
import { Reply, Request as RequestSchema, SidekickTransport } from "./protocol.ts";
import type { Descriptor, Request } from "./protocol.ts";

class AttachmentRequestError extends Error {
  constructor(
    message: string,
    readonly facts?: unknown,
  ) {
    super(message);
    this.name = "AttachmentRequestError";
  }
}
export function requestAttachment(
  path: string,
  request: Request,
  update?: (value: unknown) => Operation<void>,
  expected?: Descriptor,
): Operation<unknown> {
  return scoped(function* () {
    let effective = RequestSchema.parse(request);
    let journalReply;
    if (effective.method === "entry" && effective.view === "journal") {
      const policy = resolveJournalMaxBytes(effective.yq ?? ".", effective.maxBytes);
      if (!policy.ok) {
        throw policy.error;
      }
      if (policy.value !== undefined) {
        effective = { ...effective, maxBytes: policy.value };
        journalReply = { id: 1, maxBytes: policy.value };
      }
    }
    const host = yield* SidekickTransport.expect();
    const { descriptor, wire } = yield* host.connect(path, journalReply);
    if (expected !== undefined && JSON.stringify(descriptor) !== JSON.stringify(expected)) {
      throw new Error("The attachment association now names a different live owner.");
    }
    yield* wire.send({ id: 0, request: { method: "hello", descriptor } });
    const hello = Reply.parse(yield* wire.receive());
    if (hello.id !== 0 || hello.kind !== "value") {
      throw new Error("The attachment handshake was refused.");
    }
    yield* wire.send({ id: 1, request: effective });
    while (true) {
      const reply = Reply.parse(yield* wire.receive());
      if (reply.id !== 1) {
        throw new Error("The attachment reply names another request.");
      }
      if (reply.kind === "error") {
        throw new AttachmentRequestError(reply.error, reply.facts);
      }
      if (reply.kind === "value") {
        return reply.value;
      }
      if (update !== undefined) {
        yield* update(reply.value);
      }
    }
  });
}
export function attachmentDescriptor(path: string): Operation<Descriptor> {
  return scoped(function* () {
    const { descriptor, wire } = yield* (yield* SidekickTransport.expect()).connect(path);
    yield* wire.send({ id: 0, request: { method: "hello", descriptor } });
    const reply = Reply.parse(yield* wire.receive());
    if (reply.id !== 0 || reply.kind !== "value") {
      throw new Error("The attachment handshake was refused.");
    }
    return descriptor;
  });
}
