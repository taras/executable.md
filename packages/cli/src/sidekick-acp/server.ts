import { createSignal, ensure, scoped, spawn, useScope } from "effection";
import type { Operation } from "effection";
import type { RootReads } from "../repl/sidekick/requests.ts";
import {
  readEntryJournal,
  readEntryOutputWindow,
  readEntryPrompt,
  readEntrySource,
} from "../repl/sidekick/entry-inspection.ts";
import type { SidekickOwner } from "../repl/sidekick/owner.ts";
import type {
  SidekickDispatch,
  SidekickDispatchSnapshot,
  SidekickExchange,
} from "../repl/sidekick/dispatch.ts";
import { SidekickOrigin } from "../repl/sidekick/dispatch.ts";
import { Cursor, Envelope, MAILBOX, SidekickTransport } from "./protocol.ts";
import type { Descriptor, Request, Wire } from "./protocol.ts";

interface AttachmentRoot {
  readonly owner: SidekickOwner;
  readonly dispatch: SidekickDispatch;
  readonly reads: RootReads;
  readonly execution: string;
  readonly cwd: string;
}
function publicExchange(snapshot: SidekickDispatchSnapshot, cancelled = false) {
  const end = snapshot.terminal;
  const partial =
    end !== undefined && !end.ok && "partial" in end.error ? end.error.partial : undefined;
  const output = end?.ok
    ? end.value.output
    : partial !== null &&
        typeof partial === "object" &&
        "output" in partial &&
        typeof partial.output === "string"
      ? partial.output
      : "";
  const reading = snapshot.reading;
  const message = snapshot.message;
  const own =
    reading.ok && message !== undefined
      ? reading.value.chat.findIndex(
          (one) =>
            one.kind === "person" &&
            one.id === message.id &&
            one.conversation === message.conversation,
        )
      : -1;
  const after = reading.ok && own >= 0 ? reading.value.chat.slice(own + 1) : [];
  const next = after.findIndex((one) => one.kind === "person");
  const replies = (next < 0 ? after : after.slice(0, next)).flatMap((one) =>
    one.kind === "reply" ? [{ response: one.response, text: one.text }] : [],
  );
  return {
    message: snapshot.message ?? null,
    origin: snapshot.origin,
    activity:
      snapshot.live === undefined
        ? null
        : { response: snapshot.live.response, phase: snapshot.live.phase },
    preview:
      snapshot.preview === undefined
        ? null
        : { provisional: true, response: snapshot.preview.response, text: snapshot.preview.output },
    ending:
      end === undefined
        ? null
        : {
            joined: true,
            outcome: cancelled ? "cancelled" : end.ok ? "completed" : "failed",
            error: end.ok ? null : end.error.message,
          },
    output,
    outputs: replies,
  };
}
type PublicExchange = ReturnType<typeof publicExchange>;
function pair(root: AttachmentRoot, descriptor: Descriptor): void {
  const read = root.owner.reading;
  if (
    !read.ok ||
    read.value.active !== descriptor.conversation ||
    !read.value.conversations.some(
      (one) => one.id === descriptor.conversation && one.phase === "activated",
    )
  ) {
    throw new Error("The attachment's established Sidekick conversation is no longer selected.");
  }
}
function status(root: AttachmentRoot, descriptor: Descriptor) {
  const read = root.owner.reading;
  if (!read.ok) {
    throw read.error;
  }
  const head = root.reads.acknowledged();
  if (!head.ok) {
    throw head.error;
  }
  return {
    owner: descriptor.owner,
    execution: descriptor.execution,
    conversation: descriptor.conversation,
    cwd: descriptor.cwd,
    busy: root.owner.busy,
    exchange:
      root.dispatch.current === undefined ? null : publicExchange(root.dispatch.current.snapshot),
    feedbackUnestablished: read.value.unestablished.filter(
      (one) => one.conversation === descriptor.conversation,
    ).length,
    canonical: read.value.conversations
      .filter((one) => one.id === descriptor.conversation)
      .map((one) => ({ conversation: one.id, attempted: one.attempted, completed: one.completed })),
    messages: read.value.chat
      .filter(
        (one) =>
          one.kind === "person" &&
          one.id !== undefined &&
          one.conversation === descriptor.conversation,
      )
      .map((one) =>
        one.kind === "person"
          ? { execution: descriptor.execution, conversation: one.conversation, id: one.id }
          : null,
      ),
    entries: head.value.entries.map((one, index) => ({
      entry: index + 1,
      key: one.key,
      outcome: one.terminal?.status ?? null,
    })),
    questionPending: root.owner.questions.pending !== undefined,
  };
}
function replay(root: AttachmentRoot, descriptor: Descriptor) {
  const read = root.owner.reading;
  if (!read.ok) {
    throw read.error;
  }
  return read.value.chat
    .filter(
      (one) =>
        one.conversation === descriptor.conversation &&
        (one.kind === "person" || one.kind === "reply"),
    )
    .map((one) =>
      one.kind === "person"
        ? { kind: "person", text: one.text }
        : one.kind === "reply"
          ? { kind: "reply", text: one.text }
          : { kind: "unknown", text: "" },
    );
}
function entry(
  root: AttachmentRoot,
  descriptor: Descriptor,
  request: Extract<Request, { method: "entry" }>,
) {
  const head = root.reads.acknowledged();
  if (!head.ok) {
    throw head.error;
  }
  const history = { entries: head.value.entries, printing: root.reads.printing() };
  let selected: { entry: number; prompt?: number; field?: string; offset?: number } = {
    entry: request.entry,
    ...(request.prompt === undefined ? {} : { prompt: request.prompt }),
    ...(request.field === undefined ? {} : { field: request.field }),
    offset: undefined,
  };
  if (request.cursor !== undefined) {
    const cursor = Cursor.parse(JSON.parse(decodeURIComponent(request.cursor)));
    if (
      cursor.execution !== descriptor.execution ||
      cursor.conversation !== descriptor.conversation ||
      cursor.view !== request.view ||
      cursor.next.entry !== request.entry ||
      (request.prompt !== undefined && cursor.next.prompt !== request.prompt) ||
      (request.field !== undefined && cursor.next.field !== request.field)
    ) {
      throw new Error("The continuation belongs to another exact evidence page.");
    }
    selected = { ...cursor.next, offset: cursor.next.offset };
  }
  const result =
    request.view === "source"
      ? readEntrySource(selected, history)
      : request.view === "output"
        ? readEntryOutputWindow(selected, history)
        : request.view === "journal"
          ? readEntryJournal(selected, history)
          : readEntryPrompt(selected, history);
  if (!result.ok) {
    throw result.error;
  }
  const page = result.value;
  const cursor = (next: typeof page.next) =>
    next === null
      ? null
      : encodeURIComponent(
          JSON.stringify({
            version: 1,
            execution: descriptor.execution,
            conversation: descriptor.conversation,
            view: request.view,
            next: {
              entry: next.entry,
              offset: next.offset,
              ...("prompt" in next ? { prompt: next.prompt } : {}),
              ...("field" in next ? { field: next.field } : {}),
            },
          }),
        );
  return {
    ...page,
    execution: descriptor.execution,
    conversation: descriptor.conversation,
    previous: cursor(page.previous),
    next: cursor(page.next),
  };
}
function* observe(
  exchange: SidekickExchange,
  wire: Wire,
  id: number,
  cancelled: WeakSet<SidekickExchange>,
): Operation<PublicExchange> {
  return yield* scoped(function* () {
    const observed = yield* exchange.observe();
    const queue: PublicExchange[] = [publicExchange(observed.snapshot, cancelled.has(exchange))];
    const wake = createSignal<void, never>();
    const changed = yield* wake;
    const updates = yield* spawn(function* () {
      while (true) {
        const snapshot = (yield* observed.changes.next()).value;
        if (queue.length >= MAILBOX) {
          wire.close();
          throw new Error("The attachment observer exceeded 64 pending updates.");
        }
        queue.push(publicExchange(snapshot, cancelled.has(exchange)));
        wake.send();
      }
    });
    while (true) {
      while (queue.length === 0) {
        yield* changed.next();
      }
      const snapshot = queue.shift();
      if (snapshot === undefined) {
        continue;
      }
      yield* wire.send({ id, kind: "update", value: snapshot });
      if (snapshot.ending !== null) {
        yield* updates.halt();
        return snapshot;
      }
    }
  });
}
export function* useSidekickAttachment(path: string, root: AttachmentRoot): Operation<Descriptor> {
  const host = yield* SidekickTransport.expect();
  if (!host.supported()) {
    throw new Error("Sidekick ACP requires a same-user POSIX Unix socket.");
  }
  const read = root.owner.reading;
  if (!read.ok) {
    throw read.error;
  }
  const conversation = read.value.active;
  if (
    conversation === undefined ||
    !read.value.conversations.some((one) => one.id === conversation && one.phase === "activated")
  ) {
    throw new Error("Sidekick ACP initialization did not establish a selected conversation.");
  }
  const listener = yield* host.publish(path, {
    owner: host.identify(),
    execution: root.execution,
    conversation,
    cwd: root.cwd,
  });
  const descriptor = listener.descriptor;
  const scope = yield* useScope();
  const cancelled = new WeakSet<SidekickExchange>();
  const attachments = new Map<string, { exchange?: SidekickExchange; closing?: boolean }>();
  yield* ensure(() => {
    attachments.clear();
  });
  yield* spawn(function* () {
    while (true) {
      const incoming = yield* listener.accept();
      scope.run(function* () {
        try {
          yield* scoped(function* () {
            const wire = yield* incoming;
            const hello = Envelope.parse(yield* wire.receive());
            if (
              hello.request.method !== "hello" ||
              JSON.stringify(hello.request.descriptor) !== JSON.stringify(descriptor)
            ) {
              throw new Error("The attachment identity handshake failed.");
            }
            pair(root, descriptor);
            yield* wire.send({ id: hello.id, kind: "value", value: descriptor });
            const pending = new Set<number>();
            while (true) {
              const envelope = Envelope.parse(yield* wire.receive());
              pair(root, descriptor);
              if (pending.has(envelope.id) || pending.size >= MAILBOX) {
                throw new Error("The attachment request bound was exceeded.");
              }
              pending.add(envelope.id);
              yield* spawn(function* () {
                try {
                  const request = envelope.request;
                  let value: unknown;
                  if (request.method === "hello") {
                    throw new Error("Attachment handshake already completed.");
                  }
                  if (request.method === "attach") {
                    if (request.cwd !== descriptor.cwd) {
                      throw new Error("Attachment cwd mismatch.");
                    }
                    const attachment = host.identify();
                    attachments.set(attachment, {});
                    value = { attachment };
                  } else if (request.method === "status") {
                    value = status(root, descriptor);
                  } else if (request.method === "entry") {
                    value = entry(root, descriptor, request);
                  } else if (request.method === "message") {
                    const followed = root.dispatch.follow(request.reference);
                    if (!followed.ok) {
                      throw followed.error;
                    }
                    value = request.follow
                      ? yield* observe(followed.value, wire, envelope.id, cancelled)
                      : publicExchange(followed.value.snapshot, cancelled.has(followed.value));
                  } else {
                    const held = attachments.get(request.attachment);
                    if (held === undefined) {
                      throw new Error("The attachment session was not issued by this live owner.");
                    }
                    if (held.closing && request.method !== "cancel" && request.method !== "close") {
                      throw new Error("This attachment is closing.");
                    }
                    if (request.method === "load") {
                      if (request.cwd !== descriptor.cwd) {
                        throw new Error("Attachment cwd mismatch.");
                      }
                      value = {
                        attachment: request.attachment,
                        replay: replay(root, descriptor),
                        status: status(root, descriptor),
                      };
                    } else if (request.method === "cancel" || request.method === "close") {
                      if (request.method === "close") {
                        held.closing = true;
                      }
                      const exact = held.exchange;
                      if (exact !== undefined && exact.snapshot.terminal === undefined) {
                        cancelled.add(exact);
                        yield* exact.cancel();
                      }
                      if (request.method === "close") {
                        attachments.delete(request.attachment);
                      }
                      value = { joined: true };
                    } else {
                      if (
                        held.exchange !== undefined &&
                        held.exchange.snapshot.terminal === undefined
                      ) {
                        throw new Error("This attachment already owns an exchange.");
                      }
                      yield* SidekickOrigin.set({ kind: "acp", attachment: request.attachment });
                      const sent = yield* root.dispatch.send(request.text);
                      if (!sent.ok) {
                        throw sent.error;
                      }
                      held.exchange = sent.value;
                      value = yield* observe(sent.value, wire, envelope.id, cancelled);
                    }
                  }
                  yield* wire.send({ id: envelope.id, kind: "value", value });
                } catch (error) {
                  try {
                    yield* wire.send({
                      id: envelope.id,
                      kind: "error",
                      error:
                        error instanceof Error
                          ? error.message.slice(0, 4096)
                          : "The attachment request failed.",
                    });
                  } catch {
                    wire.close();
                  }
                } finally {
                  pending.delete(envelope.id);
                }
              });
            }
          });
        } catch {
          /* A connection owns observation; the live root owns production. */
        }
      });
    }
  });
  return descriptor;
}
