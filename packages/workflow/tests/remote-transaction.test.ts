/**
 * Tier WRH — `transact()` against an owner somewhere else.
 *
 * The contract is that arbitrary callback control flow stays legal while the
 * commit stays atomic, and the way that is achieved is by never inferring what
 * the body did: the body runs locally, and only what it enlisted is sent. So
 * these tests are mostly about what does *not* travel — a body that suspends
 * leaves no transaction open, a body that fails sends nothing, and a result the
 * owner refused is not returned as a success.
 *
 * The link is a deterministic fake because Cloudflare mechanics are not the
 * subject here. What the owner does with an intent is proven on real workerd;
 * what the client sends is proven here.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { Err, Ok, sleep, type Operation, type Result } from "effection";
import type { DurableEvent } from "@executablemd/durable-streams";
import {
  type CommitIntent,
  createTransactionGate,
  type OwnerLink,
  RemoteTransactionError,
  requireNoOpenTransaction,
  type StartingFrontier,
  transactRemotely,
} from "../src/remote/collector.ts";

/** The name a test event carries, read rather than asserted. */
function nameOf(entry: DurableEvent | undefined): string {
  if (entry === undefined || !("description" in entry)) {
    return "";
  }
  const description = entry.description;
  if (description === null || typeof description !== "object") {
    return "";
  }
  const name = (description as Record<string, unknown>)["name"];
  return typeof name === "string" ? name : "";
}

/** Rename a test event in place, to prove the collector cloned it. */
function rename(entry: DurableEvent, name: string): void {
  if (!("description" in entry)) {
    return;
  }
  const description = entry.description;
  if (description !== null && typeof description === "object") {
    (description as Record<string, unknown>)["name"] = name;
  }
}

function event(name: string): DurableEvent {
  return {
    type: "yield",
    coroutineId: "root",
    description: { type: "test", name },
    result: { status: "ok", value: name },
  } as DurableEvent;
}

/** A link that records what it was asked, and answers how a test tells it to. */
function link(
  options: {
    frontier?: StartingFrontier;
    commit?: (intent: CommitIntent) => Result<void>;
  } = {},
) {
  const sent: CommitIntent[] = [];
  const starting: StartingFrontier = options.frontier ?? {
    workspaceRootId: "root-a",
    journalEventId: "event-0",
    events: [event("already-there")],
  };
  const owner: OwnerLink = {
    *frontier(): Operation<StartingFrontier> {
      return starting;
    },
    *commit(intent: CommitIntent): Operation<Result<void>> {
      sent.push(intent);
      return options.commit === undefined ? Ok(undefined) : options.commit(intent);
    },
  };
  return { owner, sent, starting };
}

describe("a remote transaction", () => {
  it("sends one intent carrying what the body enlisted", function* () {
    const { owner, sent } = link();
    const gate = createTransactionGate();

    const result = yield* transactRemotely(owner, gate, function* (transaction) {
      yield* transaction.journal.append(event("one"));
      yield* transaction.journal.append(event("two"));
      return "body value";
    });

    expect(result.ok).toBe(true);
    expect(result.ok && result.value).toBe("body value");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.expectedWorkspaceRootId).toBe("root-a");
    expect(sent[0]?.expectedJournalEventId).toBe("event-0");
    expect(sent[0]?.events).toHaveLength(2);
  });

  it("reads the starting prefix and its own appends, in order", function* () {
    const { owner } = link();
    const gate = createTransactionGate();
    let seen: string[] = [];

    yield* transactRemotely(owner, gate, function* (transaction) {
      yield* transaction.journal.append(event("mine"));
      const all = yield* transaction.journal.readAll();
      seen = all.map(nameOf);
      return undefined;
    });

    expect(seen).toEqual(["already-there", "mine"]);
  });

  it("lets the body cross a suspension point with no owner transaction open", function* () {
    const { owner, sent } = link();
    const gate = createTransactionGate();

    const result = yield* transactRemotely(owner, gate, function* (transaction) {
      yield* transaction.journal.append(event("before"));
      // Nothing is held on the owner while this waits, which is the whole
      // reason the body runs here rather than inside a transaction.
      yield* sleep(1);
      yield* transaction.journal.append(event("after"));
      return "crossed";
    });

    expect(result.ok && result.value).toBe("crossed");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.events).toHaveLength(2);
  });

  it("sends nothing when the body fails", function* () {
    const { owner, sent } = link();
    const gate = createTransactionGate();

    let raised: unknown;
    try {
      yield* transactRemotely(owner, gate, function* (transaction) {
        yield* transaction.journal.append(event("doomed"));
        throw new Error("the body decided otherwise");
      });
    } catch (error) {
      raised = error;
    }

    expect(String(raised)).toContain("the body decided otherwise");
    expect(sent).toEqual([]);
    expect(gate.open).toBe(false);
  });

  it("returns the owner's refusal rather than the body's value", function* () {
    const { owner, sent } = link({ commit: () => Err(new Error("stale expected root")) });
    const gate = createTransactionGate();

    const result = yield* transactRemotely(owner, gate, function* (transaction) {
      yield* transaction.journal.append(event("hopeful"));
      return "never returned";
    });

    expect(result.ok).toBe(false);
    expect(!result.ok && String(result.error)).toContain("stale expected root");
    expect(sent).toHaveLength(1);
  });

  it("refuses a transaction opened inside a transaction", function* () {
    const { owner, sent } = link();
    const gate = createTransactionGate();

    let raised: unknown;
    try {
      yield* transactRemotely(owner, gate, function* () {
        yield* transactRemotely(owner, gate, function* () {
          return undefined;
        });
        return undefined;
      });
    } catch (error) {
      raised = error;
    }

    expect(raised).toBeInstanceOf(RemoteTransactionError);
    expect((raised as RemoteTransactionError).refusal).toBe("nested-transaction");
    expect(sent).toEqual([]);
  });

  it("refuses an ordinary same-handle operation while a body is running", function* () {
    const { owner } = link();
    const gate = createTransactionGate();
    let raised: unknown;

    yield* transactRemotely(owner, gate, function* () {
      try {
        requireNoOpenTransaction(gate);
      } catch (error) {
        raised = error;
      }
      return undefined;
    });

    expect(raised).toBeInstanceOf(RemoteTransactionError);
    expect((raised as RemoteTransactionError).refusal).toBe("operation-inside-body");
    // And the gate is closed again afterwards, so the next operation is fine.
    requireNoOpenTransaction(gate);
  });

  it("refuses a transaction handle used after its body closed", function* () {
    const { owner } = link();
    const gate = createTransactionGate();
    let escaped: { journal: { append(event: DurableEvent): Operation<void> } } | undefined;

    yield* transactRemotely(owner, gate, function* (transaction) {
      escaped = transaction;
      return undefined;
    });

    let raised: unknown;
    try {
      yield* escaped!.journal.append(event("too late"));
    } catch (error) {
      raised = error;
    }
    expect((raised as RemoteTransactionError).refusal).toBe("transaction-closed");
  });

  it("commits what it was handed, not what the caller mutated afterwards", function* () {
    const { owner, sent } = link();
    const gate = createTransactionGate();
    const mutable = event("original");

    yield* transactRemotely(owner, gate, function* (transaction) {
      yield* transaction.journal.append(mutable);
      rename(mutable, "changed");
      return undefined;
    });

    const committed = sent[0]?.events[0];
    expect(nameOf(committed)).toBe("original");
  });
});
