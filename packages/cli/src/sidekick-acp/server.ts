import { resolveJournalMaxBytes } from "../repl/sidekick/journal-policy.ts";
import {
  createSignal,
  ensure,
  Err,
  Ok,
  race,
  scoped,
  spawn,
  useScope,
  withResolvers,
} from "effection";
import type { Operation, Result, Stream, Task } from "effection";
import type { RootReads } from "../repl/sidekick/requests.ts";
import {
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
import {
  Cursor,
  Envelope,
  MAILBOX,
  MAX_FRAME,
  SidekickTransport,
  SubmitRecord,
} from "./protocol.ts";
import type { Descriptor, Request, Wire, SubmissionReference } from "./protocol.ts";

import { createChildRequests } from "../headless/requests.ts";
import type { ChildInput } from "../headless/requests.ts";
import { serveChildUi } from "../headless/ui.ts";
import type { DirectRepl } from "../repl/program.ts";
import type { ReplSubmission, ReplSession } from "../repl/session.ts";
import type { ReplLiveScreen } from "../repl/live-screen.ts";

interface AttachmentRoot {
  readonly available?: () => boolean;
  readonly child?: {
    readonly sessionId: string;
    readonly session: ReplSession;
    readonly direct: DirectRepl;
    readonly view: ReplLiveScreen;
  };
  readonly owner: SidekickOwner;
  readonly dispatch: SidekickDispatch;
  readonly reads: RootReads;
  readonly execution: string;
  readonly cwd: string;
}
function publicExchange(
  snapshot: SidekickDispatchSnapshot,
  cancelled = false,
  inputs?: ChildInput[],
) {
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
    ...(inputs === undefined ? {} : { inputs }),
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
    root.available?.() === false ||
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
    messages: read.value.chat.flatMap((one) =>
      one.kind === "person" && one.conversation === descriptor.conversation
        ? [{ execution: descriptor.execution, conversation: one.conversation, id: one.id }]
        : [],
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
  return read.value.chat.flatMap((one) =>
    one.conversation === descriptor.conversation && (one.kind === "person" || one.kind === "reply")
      ? [{ kind: one.kind, text: one.text }]
      : [],
  );
}
function* entry(
  root: AttachmentRoot,
  descriptor: Descriptor,
  request: Extract<Request, { method: "entry" }>,
) {
  if (request.view === "journal") {
    const result = yield* root.reads.inspectJournal({
      entry: request.entry,
      yq: request.yq,
      maxBytes: request.maxBytes,
    });
    if (!result.ok) {
      throw result.error;
    }
    return result.value;
  }
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
  root?: AttachmentRoot,
  inputs?: ReturnType<typeof createChildRequests>,
): Operation<PublicExchange> {
  return yield* scoped(function* () {
    const observed = yield* exchange.observe();
    const queue: PublicExchange[] = [];
    const wake = createSignal<void, never>();
    const changed = yield* wake;
    const updates = yield* spawn(function* () {
      while (true) {
        const snapshot = (yield* observed.changes.next()).value;
        if (queue.length >= MAILBOX) {
          wire.close();
          throw new Error("The attachment observer exceeded 64 pending updates.");
        }
        queue.push(publicExchange(snapshot, cancelled.has(exchange), inputs?.list()));
        wake.send();
      }
    });
    if (root?.child !== undefined && inputs !== undefined) {
      for (const changes of [
        root.owner.questions.changes,
        root.child.session.changes,
        root.child.session.agentChanges,
      ]) {
        const source = yield* changes;
        yield* spawn(function* () {
          while (true) {
            const next = yield* source.next();
            if (next.done) {
              return;
            }
            if (queue.length >= MAILBOX) {
              wire.close();
              return;
            }
            queue.push(publicExchange(exchange.snapshot, cancelled.has(exchange), inputs.list()));
            wake.send();
          }
        });
      }
    }
    queue.push(publicExchange(exchange.snapshot, cancelled.has(exchange), inputs?.list()));
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
function submissionInteraction(
  child: NonNullable<AttachmentRoot["child"]>,
  descriptor: Descriptor,
  wire: Wire,
  id: number,
) {
  type Part = {
    text: string;
    done: boolean;
    textTaken: boolean;
    credit: ReturnType<typeof withResolvers<void>>;
  };
  let part: Part | undefined;
  let waiting = withResolvers<void>();
  let inputDone = false;
  let inputFailure: Error | undefined;
  let handle: ReplSubmission | undefined;
  let reference: SubmissionReference | null = null;
  let startup: Task<void> | undefined;
  let requested = false;
  let fixed = false;
  let stopping: Operation<Result<void>> | undefined;
  const admitted = withResolvers<void>();
  let notification = withResolvers<void>();
  let dirty = true;
  const ready = withResolvers<Result<ReplSubmission>>();
  const complete = withResolvers<SubmitRecord>();

  function discard(): void {
    inputFailure = new Error("The direct source interaction ended before normal completion.");
    part?.credit.reject(inputFailure);
    part = undefined;
    waiting.resolve();
  }
  const source: Stream<string, void> = {
    *[Symbol.iterator]() {
      return {
        *next(): Operation<IteratorResult<string, void>> {
          while (true) {
            if (inputFailure !== undefined) {
              throw inputFailure;
            }
            if (part !== undefined) {
              const held = part;
              if (!held.textTaken && held.text.length > 0) {
                held.textTaken = true;
                if (!held.done) {
                  part = undefined;
                  held.credit.resolve();
                }
                return { done: false, value: held.text };
              }
              part = undefined;
              inputDone = held.done;
              held.credit.resolve();
              if (inputDone) {
                return { done: true, value: undefined };
              }
            }
            if (inputDone) {
              return { done: true, value: undefined };
            }
            waiting = withResolvers<void>();
            yield* waiting.operation;
          }
        },
      };
    },
  };
  function progress(): SubmitRecord | undefined {
    if (reference === null) {
      return undefined;
    }
    const session = child.session;
    if (
      session.lifecycle.entry !== reference.entry &&
      session.printing?.entry !== reference.entry
    ) {
      return undefined;
    }
    const head = session.navigation.head;
    if (!["live", "pausing", "paused", "settling"].includes(head)) {
      return undefined;
    }
    const reading = session.reading(undefined);
    const retained = reading.ok
      ? reading.value.model.entries.find((one) => one.key === reference?.entry)?.terminal?.output
      : undefined;
    const printing = session.printing;
    const text = retained ?? (printing?.entry === reference.entry ? printing.output : "");
    const points = Array.from(text);
    const occurrences =
      session.lifecycle.entry === reference.entry ? session.lifecycle.occurrences : [];
    return SubmitRecord.parse({
      kind: "progress",
      submission: reference,
      head,
      output: {
        text: points.slice(-4096).join(""),
        offset: Math.max(0, points.length - 4096),
        length: points.length,
      },
      waiting: {
        questions: occurrences.filter((one) => one.waiting.includes("question")).length,
        permissions: occurrences.filter((one) => one.waiting.includes("permission")).length,
      },
    });
  }
  function* settlement(): Operation<SubmitRecord> {
    const submitted = yield* ready.operation;
    if (startup !== undefined) {
      yield* startup.halt();
    }
    if (handle === undefined) {
      if (!requested) {
        throw submitted.ok
          ? new Error("Direct admission supplied no exact handle.")
          : submitted.error;
      }
      return {
        kind: "finished",
        submission: null,
        joined: true,
        outcome: "interrupted",
        result: null,
        error: null,
        journal: null,
      };
    }
    const exact = handle;
    const joined = yield* exact.join();
    const output = yield* exact.output();
    const stopped = stopping === undefined ? undefined : yield* stopping;
    const reading = child.session.reading(undefined);
    const terminal = reading.ok
      ? reading.value.model.entries.find((one) => one.key === exact.entry)?.terminal
      : undefined;
    const journal = !reading.ok
      ? "unavailable"
      : terminal === undefined
        ? "unfinished"
        : terminal.status === "ok"
          ? "completed"
          : terminal.status === "err"
            ? "failed"
            : "cancelled";
    const interrupted = requested && stopped?.ok === true && output.ok && journal === "cancelled";
    // output() retains an actual Stop failure, unlike a stale Stop refusal.
    const failure =
      !joined.ok && !interrupted ? joined.error : !output.ok ? output.error : undefined;
    if (failure !== undefined) {
      return {
        kind: "finished",
        submission: reference,
        joined: true,
        outcome: "failed",
        result: null,
        error: { name: failure.name, message: failure.message },
        journal,
      };
    }
    return SubmitRecord.parse({
      kind: "finished",
      submission: reference,
      joined: true,
      outcome: interrupted ? "interrupted" : "completed",
      result: joined.ok ? { value: joined.value } : null,
      error: null,
      journal,
    });
  }
  return {
    offer(request: Extract<Request, { method: "submit-source" }>): Operation<void> {
      if (fixed || requested || inputDone || inputFailure !== undefined || part !== undefined) {
        throw new Error("This direct submission has no source credit.");
      }
      const credit = withResolvers<void>();
      part = { text: request.text, done: request.done, textTaken: false, credit };
      waiting.resolve();
      return credit.operation;
    },
    *interrupt(): Operation<void> {
      if (fixed) {
        throw new Error("This exact submission has already finished.");
      }
      if (!requested) {
        requested = true;
        discard();
        const done = withResolvers<Result<void>>();
        stopping = done.operation;
        yield* spawn(function* () {
          let outcome: Result<void> = Ok(undefined);
          try {
            if (startup !== undefined) {
              yield* startup.halt();
            }
            if (handle !== undefined) {
              outcome = yield* child.session.stopEntry(handle.entry);
            }
          } catch (error) {
            outcome = Err(error instanceof Error ? error : new Error(String(error)));
          } finally {
            done.resolve(outcome);
          }
        });
      }
      if (stopping !== undefined) {
        yield* stopping;
      }
    },
    *run(): Operation<SubmitRecord> {
      return yield* scoped(function* () {
        yield* ensure(discard);
        for (const stream of [
          child.session.changes,
          child.session.outputs,
          child.session.lifecycleChanges,
          child.session.expansion.states,
        ]) {
          const changes = yield* stream;
          yield* spawn(function* () {
            while (!(yield* changes.next()).done) {
              dirty = true;
              notification.resolve();
            }
          });
        }
        startup = yield* spawn(function* () {
          let result: Result<ReplSubmission> = Err(new Error("Direct startup was withdrawn."));
          try {
            result = yield* child.direct.submit(source, (submission) => {
              handle = submission;
              reference = {
                sessionId: child.sessionId,
                execution: descriptor.execution,
                entry: submission.entry,
              };
              admitted.resolve();
            });
          } catch (error) {
            result = Err(error instanceof Error ? error : new Error(String(error)));
          } finally {
            ready.resolve(result);
          }
        });
        yield* spawn(function* () {
          try {
            const record = yield* settlement();
            fixed = true;
            complete.resolve(record);
          } catch (error) {
            fixed = true;
            complete.reject(error instanceof Error ? error : new Error(String(error)));
          }
        });
        const first = yield* race([
          (function* () {
            yield* admitted.operation;
            return true;
          })(),
          (function* () {
            yield* complete.operation;
            return false;
          })(),
        ]);
        if (first || reference !== null) {
          yield* wire.send({
            id,
            kind: "update",
            value: { kind: "admitted", submission: reference },
          });
        }
        let latest: SubmitRecord | undefined;
        while (!fixed) {
          if (dirty) {
            notification = withResolvers<void>();
            dirty = false;
            const snapshot = progress();
            if (snapshot !== undefined && JSON.stringify(snapshot) !== JSON.stringify(latest)) {
              latest = snapshot;
              yield* wire.send({ id, kind: "update", value: snapshot });
            }
          }
          if (!dirty) {
            yield* race([
              (function* () {
                yield* complete.operation;
              })(),
              notification.operation,
            ]);
          }
        }
        return yield* complete.operation;
      });
    },
  };
}

function boundedFinal(id: number, record: SubmitRecord) {
  const reply = { id, kind: "value", value: record };
  if (new TextEncoder().encode(JSON.stringify(reply) + "\n").length <= MAX_FRAME) {
    return reply;
  }
  const unavailable: SubmitRecord = {
    kind: "unavailable",
    submission: record.submission,
    reason: "The complete joined result exceeds the attachment frame bound.",
  };
  return record.kind === "finished" && record.outcome === "failed"
    ? {
        id,
        kind: "error",
        error: "The joined failure payload exceeds the attachment frame bound.",
        facts: unavailable,
      }
    : { id, kind: "value", value: unavailable };
}

export function* useSidekickAttachment(
  path: string,
  root: AttachmentRoot,
  prepared?: string,
): Operation<Descriptor> {
  const host = yield* SidekickTransport.expect();
  if (!host.supported()) {
    throw new Error("Sidekick ACP requires a same-user POSIX Unix socket.");
  }
  const read = root.owner.reading;
  if (!read.ok) {
    throw read.error;
  }
  const conversation = prepared ?? read.value.active;
  if (
    conversation === undefined ||
    !read.value.conversations.some(
      (one) =>
        one.id === conversation &&
        (one.phase === "activated" ||
          (root.child !== undefined && prepared === conversation && one.phase === "prepared")),
    )
  ) {
    throw new Error("Sidekick ACP initialization did not establish a selected conversation.");
  }
  const listener = yield* host.publish(path, {
    owner: root.child?.sessionId ?? host.identify(),
    execution: root.execution,
    conversation,
    cwd: root.cwd,
  });
  const descriptor = listener.descriptor;
  const scope = yield* useScope();
  const cancelled = new WeakSet<SidekickExchange>();
  const inputs =
    root.child === undefined
      ? undefined
      : createChildRequests(root.owner, root.child.session, host.identify);
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
            const submissions = new Map<number, ReturnType<typeof submissionInteraction>>();
            while (true) {
              const envelope = Envelope.parse(yield* wire.receive());
              pair(root, descriptor);
              if (envelope.request.method === "ui") {
                if (root.child === undefined) {
                  yield* wire.send({
                    id: envelope.id,
                    kind: "error",
                    error: "This prepared attachment grants no child UI.",
                  });
                  return;
                }
                try {
                  yield* race([
                    (function* (): Operation<never> {
                      const changes = yield* root.owner.changes;
                      while (true) {
                        yield* changes.next();
                        pair(root, descriptor);
                      }
                    })(),
                    serveChildUi(wire, root.child.view, envelope.request.size, envelope.id),
                  ]);
                } catch (error) {
                  yield* wire.send({
                    id: envelope.id,
                    kind: "error",
                    error: error instanceof Error ? error.message : "Child UI refused.",
                  });
                }
                return;
              }
              if (pending.has(envelope.id) || pending.size >= MAILBOX) {
                throw new Error("The attachment request bound was exceeded.");
              }
              pending.add(envelope.id);
              let transfer: Operation<void> | undefined;
              let interaction: ReturnType<typeof submissionInteraction> | undefined;
              let refused: Error | undefined;
              try {
                if (envelope.request.method === "submit") {
                  if (root.child === undefined) {
                    throw new Error("This prepared attachment grants no child submission.");
                  }
                  if (submissions.size >= MAILBOX) {
                    throw new Error("This connection has reached its direct submission bound.");
                  }
                  if (submissions.has(envelope.id)) {
                    throw new Error(
                      "This connection already used that exact submission request ID.",
                    );
                  }
                  interaction = submissionInteraction(root.child, descriptor, wire, envelope.id);
                  submissions.set(envelope.id, interaction);
                } else if (
                  envelope.request.method === "submit-source" ||
                  envelope.request.method === "submit-interrupt"
                ) {
                  if (root.child === undefined) {
                    throw new Error("This prepared attachment grants no child submission.");
                  }
                  interaction = submissions.get(envelope.request.submit);
                  if (interaction === undefined) {
                    throw new Error("This connection owns no such direct submission.");
                  }
                  if (envelope.request.method === "submit-source") {
                    transfer = interaction.offer(envelope.request);
                  }
                }
              } catch (error) {
                refused = error instanceof Error ? error : new Error(String(error));
              }
              yield* spawn(function* () {
                try {
                  const request = envelope.request;
                  if (refused !== undefined) {
                    throw refused;
                  }
                  if (request.method === "submit" && interaction !== undefined) {
                    const final = yield* interaction.run();
                    yield* wire.send(boundedFinal(envelope.id, final));
                    return;
                  }
                  if (request.method === "submit-source" || request.method === "submit-interrupt") {
                    if (request.method === "submit-source" && transfer !== undefined) {
                      yield* transfer;
                    } else if (interaction !== undefined) {
                      yield* interaction.interrupt();
                    }
                    yield* wire.send({ id: envelope.id, kind: "value", value: null });
                    return;
                  }
                  if (request.method === "submit") {
                    throw new Error("Direct submission was not established.");
                  }
                  let value: unknown;
                  if (request.method === "hello" || request.method === "ui") {
                    throw new Error("Attachment handshake already completed.");
                  }
                  if (
                    request.method === "child-offer" ||
                    request.method === "child-response" ||
                    request.method === "child-retire" ||
                    request.method === "child-release"
                  ) {
                    if (inputs === undefined) {
                      throw new Error("This prepared attachment grants no child input capability.");
                    }
                    value =
                      request.method === "child-offer"
                        ? inputs.offer(request.requestId)
                        : request.method === "child-response"
                          ? inputs.respond(request)
                          : request.method === "child-retire"
                            ? (inputs.retire(request.presentationId) ?? null)
                            : (inputs.release(request.presentationId) ?? null);
                  } else if (request.method === "attach") {
                    if (request.cwd !== descriptor.cwd) {
                      throw new Error("Attachment cwd mismatch.");
                    }
                    const attachment = host.identify();
                    attachments.set(attachment, {});
                    value = { attachment };
                  } else if (request.method === "status") {
                    value = status(root, descriptor);
                  } else if (request.method === "entry") {
                    value = yield* entry(root, descriptor, request);
                  } else if (request.method === "message") {
                    const followed = root.dispatch.follow(request.reference);
                    if (!followed.ok) {
                      throw followed.error;
                    }
                    value = request.follow
                      ? yield* observe(followed.value, wire, envelope.id, cancelled, root, inputs)
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
                      value = yield* observe(
                        sent.value,
                        wire,
                        envelope.id,
                        cancelled,
                        root,
                        inputs,
                      );
                    }
                  }
                  let journalReply;
                  if (request.method === "entry" && request.view === "journal") {
                    const policy = resolveJournalMaxBytes(request.yq ?? ".", request.maxBytes);
                    if (!policy.ok) {
                      throw policy.error;
                    }
                    if (policy.value !== undefined) {
                      journalReply = { id: envelope.id, maxBytes: policy.value };
                    }
                  }
                  yield* wire.send({ id: envelope.id, kind: "value", value }, journalReply);
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
