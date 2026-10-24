import { scoped } from "effection";
import type { Operation } from "effection";
import { Reply, SidekickTransport } from "./protocol.ts";
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
): Operation<unknown> {
  return scoped(function* () {
    const host = yield* SidekickTransport.expect();
    const { descriptor, wire } = yield* host.connect(path);
    yield* wire.send({ id: 0, request: { method: "hello", descriptor } });
    const hello = Reply.parse(yield* wire.receive());
    if (hello.id !== 0 || hello.kind !== "value") {
      throw new Error("The attachment handshake was refused.");
    }
    yield* wire.send({ id: 1, request });
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
