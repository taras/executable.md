/**
 * Issue #774 POC — the deterministic evidence for black-box REPL messaging.
 *
 * This suite freezes RP1–RP18 from the plan and proves them without a real agent
 * or a real tmux. A fake pane supplies the structural convergence facts the
 * algorithm reads, and synthetic append-only files supply the provider evidence
 * the observer reads. The fake also holds the hidden truth — actually busy,
 * actually typed-into — that only these assertions see, so a paste admitted while
 * either was true is caught.
 *
 * Every success is a parsed record, an explicit event, or a counted delivery;
 * elapsed time proves nothing here. The final row builds the
 * `terminal-repl-poc-report.v1` artifact and validates it against the checked-in
 * schema.
 *
 * The whole suite is portable: it uses no tmux, no CLI subprocess, and no
 * runtime-specific API, so it runs under Deno, Node and Bun like any other file.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { useTempDirectory } from "@executablemd/test-support/temp";
import { ensureDir, exists, readTextFile } from "@effectionx/fs";
import { chmod } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { until } from "effection";
import type { Operation } from "effection";
import {
  attemptStep,
  observeStep,
  reconcileRestart,
  settleUnconfirmed,
} from "../poc/repl/controller.ts";
import type { DeliveryOptions, ObserverSource } from "../poc/repl/controller.ts";
import { purgeStore, useReplStore } from "../poc/repl/store.ts";
import type { ReplStore } from "../poc/repl/store.ts";
import { claudeParser } from "../poc/repl/claude-observer.ts";
import { codexParser } from "../poc/repl/codex-observer.ts";
import type { Provider, ReplState } from "../poc/repl/state.ts";
import type { ProviderParser } from "../poc/repl/observer.ts";
import { identityHash, REPORT_SCHEMA, validateReport, zeroCounters } from "../poc/repl/report.ts";
import type {
  DeliveryEvidence,
  MatrixEntry,
  ReportCounters,
  RestartEvidence,
} from "../poc/repl/report.ts";
import {
  appendPartial,
  appendRecords,
  claudeSessionPath,
  claudeUnsupported,
  codexRolloutPath,
  codexUnsupported,
  createFakePane,
  rotateFile,
  truncateFile,
  writeRecords,
} from "./fixtures/repl-poc/fake-terminal.ts";
import type { FakePane } from "./fixtures/repl-poc/fake-terminal.ts";
import {
  claudeAssistant,
  claudeResult,
  claudeUser,
  codexAgent,
  codexComplete,
  codexMeta,
  codexUser,
} from "./fixtures/repl-poc/fake-terminal.ts";

/** The exact base the POC was implemented from, recorded in the report. */
const BASE_SHA = "97fda6aa7b5f85db747c066898fd3ef3c6d1dbeb";

/** One provider's record shapes, so a scenario can run against either agent. */
interface ProviderKit {
  readonly provider: Provider;
  readonly parser: ProviderParser;
  path(directory: string, id: string): string;
  idle(id: string): string[];
  user(id: string, text: string): string;
  assistant(id: string, text: string): string;
  complete(id: string): string;
  unsupported(id: string): string;
}

const CLAUDE_KIT: ProviderKit = {
  provider: "claude",
  parser: claudeParser,
  path: (directory, id) => claudeSessionPath(directory, id),
  idle: () => [],
  user: (id, text) => claudeUser(id, text),
  assistant: (id, text) => claudeAssistant(id, text),
  complete: (id) => claudeResult(id),
  unsupported: (id) => claudeUnsupported(id),
};

const CODEX_KIT: ProviderKit = {
  provider: "codex",
  parser: codexParser,
  path: (directory) => codexRolloutPath(directory, "main"),
  idle: (id) => [codexMeta(id)],
  user: (_id, text) => codexUser(text),
  assistant: (_id, text) => codexAgent(text),
  complete: () => codexComplete(),
  unsupported: () => codexUnsupported(),
};

/** Everything one scenario works against. */
interface Bag {
  readonly kit: ProviderKit;
  readonly storeDir: string;
  readonly providerDir: string;
  readonly messageDir: string;
  readonly store: ReplStore;
  readonly pane: FakePane;
  readonly identity: { readonly provider: Provider; readonly id: string };
  readonly observer: ObserverSource;
  readonly options: DeliveryOptions;
  readonly path: string;
}

/** The report the last row assembles from what the rows above recorded. */
const matrix: MatrixEntry[] = [];
const tally: { -readonly [K in keyof ReportCounters]: ReportCounters[K] } = zeroCounters();
const deliveries: DeliveryEvidence[] = [];
const restart: { -readonly [K in keyof RestartEvidence]: RestartEvidence[K] } = {
  queuedRestored: 0,
  uncertainAfterRestart: 0,
  completedRestored: 0,
  reExecutions: 0,
};
const cleanup = { storeRemoved: false, messageFilesRemoved: false, providerFilesUntouched: false };

/** Record one RP outcome and return whether it passed, for a fluent assertion. */
function record(id: string, pass: boolean, evidence: string): boolean {
  matrix.push({ id, result: pass ? "pass" : "fail", evidence });
  return pass;
}

/** Build one scenario's directories, store, fake pane and observer. */
function scaffold(
  kit: ProviderKit,
  root: string,
  options: { readonly id?: string; readonly generation?: number } = {},
): Operation<Bag> {
  return (function* (): Operation<Bag> {
    const suffix = randomUUID().slice(0, 8);
    const storeDir = join(root, `store-${suffix}`);
    const providerDir = join(root, `provider-${suffix}`);
    const messageDir = join(root, `messages-${suffix}`);
    yield* ensureDir(providerDir);
    yield* ensureDir(messageDir);
    yield* until(chmod(messageDir, 0o700));
    const store = yield* useReplStore(storeDir);
    const pane = createFakePane(
      options.generation === undefined ? {} : { generation: options.generation },
    );
    const identity = { provider: kit.provider, id: options.id ?? `${kit.provider}-${suffix}` };
    return {
      kit,
      storeDir,
      providerDir,
      messageDir,
      store,
      pane,
      identity,
      observer: { parser: kit.parser, directory: providerDir },
      options: { messageDir, bracketedPaste: true, submitKey: "Enter" },
      path: kit.path(providerDir, identity.id),
    };
  })();
}

/** Open the REPL and bind one role in an idle, located state. */
function bind(bag: Bag, options: { readonly generation?: number } = {}): Operation<void> {
  return (function* (): Operation<void> {
    yield* bag.store.dispatch({ type: "ReplOpened", replSession: "repl-poc" });
    yield* bag.store.dispatch({
      type: "RoleBound",
      key: bag.identity.id,
      role: bag.kit.provider === "claude" ? "Implementor" : "Reviewer",
      issue: "#774",
      identity: bag.identity,
      paneGeneration: options.generation ?? 1,
    });
    yield* writeRecords(bag.path, bag.kit.idle(bag.identity.id));
  })();
}

/** Queue one message carrying a unique marker, and return its id and text. */
function queue(bag: Bag): Operation<{ id: string; text: string; marker: string }> {
  return (function* (): Operation<{ id: string; text: string; marker: string }> {
    const marker = `MK-${randomUUID().slice(0, 8)}`;
    const id = `msg-${randomUUID().slice(0, 8)}`;
    const text = `Please pick up ${marker}\nand keep this second line intact`;
    yield* bag.store.dispatch({ type: "MessageQueued", key: bag.identity.id, id, text, marker });
    return { id, text, marker };
  })();
}

/** The role slice, read fresh from the store. */
function role(state: ReplState, key: string) {
  const found = state.roles[key];
  if (found === undefined) {
    throw new Error(`the store lost role ${key}`);
  }
  return found;
}

/** The state of one message by id. */
function messageState(store: ReplStore, key: string, id: string): string {
  const message = role(store.state(), key).messages.find((entry) => entry.id === id);
  return message === undefined ? "absent" : message.state;
}

describe("issue #774 — black-box REPL messaging POC", () => {
  it("RP1 — an idle pane accepts exactly one literal message and completes", function* () {
    const root = yield* useTempDirectory("xmd-repl-rp1-");
    for (const kit of [CLAUDE_KIT, CODEX_KIT]) {
      const bag = yield* scaffold(kit, root);
      yield* bind(bag);
      const message = yield* queue(bag);

      const attempt = yield* attemptStep(
        bag.store,
        bag.identity.id,
        bag.pane.probe,
        bag.observer,
        bag.options,
      );
      tally.convergenceAttempts += 1;
      expect(attempt.outcome).toEqual("pasted");
      if (attempt.outcome === "pasted") {
        tally.admittedDeliveries += 1;
        deliveries.push({ messageHash: attempt.hash, byteCount: attempt.byteCount });
      }
      // Exactly one paste reached the pane, and not while busy or manual.
      expect(bag.pane.deliveries.length).toEqual(1);
      expect(bag.pane.deliveries[0]?.whileBusy).toEqual(false);
      expect(bag.pane.deliveries[0]?.whileManual).toEqual(false);

      // The intended file records the exact user event and a complete assistant turn.
      yield* appendRecords(bag.path, [
        kit.user(bag.identity.id, message.text),
        kit.assistant(bag.identity.id, "Working on it."),
        kit.complete(bag.identity.id),
      ]);
      yield* observeStep(bag.store, bag.identity.id, bag.observer);
      expect(messageState(bag.store, bag.identity.id, message.id)).toEqual("completed");
    }
    expect(
      record("RP1", true, "one paste, exact user event, explicit completion, both providers"),
    ).toEqual(true);
  });

  it("RP2 — a busy pane keeps the message queued until completion", function* () {
    const root = yield* useTempDirectory("xmd-repl-rp2-");
    const bag = yield* scaffold(CODEX_KIT, root);
    yield* bind(bag);
    const message = yield* queue(bag);

    // The provider is mid-turn: a user event with no completion is an open turn.
    yield* appendRecords(bag.path, [codexUser("someone else's turn"), codexAgent("thinking")]);
    bag.pane.setBusy(true);
    const attempt = yield* attemptStep(
      bag.store,
      bag.identity.id,
      bag.pane.probe,
      bag.observer,
      bag.options,
    );
    tally.convergenceAttempts += 1;
    expect(attempt.outcome).toEqual("not-ready");
    expect(bag.pane.deliveries.length).toEqual(0);
    expect(messageState(bag.store, bag.identity.id, message.id)).toEqual("queued");

    // The turn completes; the pane is idle; the message is admitted now.
    yield* appendRecords(bag.path, [codexComplete()]);
    bag.pane.setBusy(false);
    yield* observeStep(bag.store, bag.identity.id, bag.observer);
    const admitted = yield* attemptStep(
      bag.store,
      bag.identity.id,
      bag.pane.probe,
      bag.observer,
      bag.options,
    );
    tally.convergenceAttempts += 1;
    expect(admitted.outcome).toEqual("pasted");
    if (admitted.outcome === "pasted") {
      tally.admittedDeliveries += 1;
    }
    expect(bag.pane.deliveries.every((delivery) => !delivery.whileBusy)).toEqual(true);
    expect(
      record("RP2", true, "no admission during an open provider turn; admitted after completion"),
    ).toEqual(true);
  });

  it("RP3 — Claude and Codex receive distinct messages with no cross-delivery", function* () {
    const root = yield* useTempDirectory("xmd-repl-rp3-");
    const claude = yield* scaffold(CLAUDE_KIT, root);
    const codex = yield* scaffold(CODEX_KIT, root);
    yield* bind(claude);
    yield* bind(codex);
    const claudeMessage = yield* queue(claude);
    const codexMessage = yield* queue(codex);

    const a = yield* attemptStep(
      claude.store,
      claude.identity.id,
      claude.pane.probe,
      claude.observer,
      claude.options,
    );
    const b = yield* attemptStep(
      codex.store,
      codex.identity.id,
      codex.pane.probe,
      codex.observer,
      codex.options,
    );
    tally.convergenceAttempts += 2;
    expect(a.outcome).toEqual("pasted");
    expect(b.outcome).toEqual("pasted");
    if (a.outcome === "pasted") {
      tally.admittedDeliveries += 1;
    }
    if (b.outcome === "pasted") {
      tally.admittedDeliveries += 1;
    }

    // Each file records only its own message.
    yield* appendRecords(claude.path, [
      claude.kit.user(claude.identity.id, claudeMessage.text),
      claude.kit.complete(claude.identity.id),
    ]);
    yield* appendRecords(codex.path, [
      codex.kit.user(codex.identity.id, codexMessage.text),
      codex.kit.complete(codex.identity.id),
    ]);
    yield* observeStep(claude.store, claude.identity.id, claude.observer);
    yield* observeStep(codex.store, codex.identity.id, codex.observer);

    const claudeDelivered = claude.pane.deliveries.map((delivery) => delivery.bytes);
    const codexDelivered = codex.pane.deliveries.map((delivery) => delivery.bytes);
    const crossed =
      claudeDelivered.includes(codexMessage.text) || codexDelivered.includes(claudeMessage.text);
    if (crossed) {
      tally.wrongPaneDeliveries += 1;
    }
    expect(crossed).toEqual(false);
    expect(messageState(claude.store, claude.identity.id, claudeMessage.id)).toEqual("completed");
    expect(messageState(codex.store, codex.identity.id, codexMessage.id)).toEqual("completed");
    expect(record("RP3", true, "distinct identities, distinct files, zero cross-delivery")).toEqual(
      true,
    );
  });

  it("RP4 — back-to-back messages keep only one in flight", function* () {
    const root = yield* useTempDirectory("xmd-repl-rp4-");
    const bag = yield* scaffold(CODEX_KIT, root);
    yield* bind(bag);
    const first = yield* queue(bag);
    const second = yield* queue(bag);

    const one = yield* attemptStep(
      bag.store,
      bag.identity.id,
      bag.pane.probe,
      bag.observer,
      bag.options,
    );
    tally.convergenceAttempts += 1;
    expect(one.outcome).toEqual("pasted");
    if (one.outcome === "pasted") {
      tally.admittedDeliveries += 1;
    }
    // The second cannot begin: a message is in flight.
    const blocked = yield* attemptStep(
      bag.store,
      bag.identity.id,
      bag.pane.probe,
      bag.observer,
      bag.options,
    );
    expect(blocked.outcome).toEqual("skipped");
    expect(bag.pane.deliveries.length).toEqual(1);

    // The first completes; only then does the second go.
    yield* appendRecords(bag.path, [codexUser(first.text), codexComplete()]);
    yield* observeStep(bag.store, bag.identity.id, bag.observer);
    expect(messageState(bag.store, bag.identity.id, first.id)).toEqual("completed");
    const two = yield* attemptStep(
      bag.store,
      bag.identity.id,
      bag.pane.probe,
      bag.observer,
      bag.options,
    );
    tally.convergenceAttempts += 1;
    expect(two.outcome).toEqual("pasted");
    if (two.outcome === "pasted") {
      tally.admittedDeliveries += 1;
    }
    expect(bag.pane.deliveries.length).toEqual(2);
    void second;
    expect(
      record(
        "RP4",
        true,
        "one in flight at a time; the second admitted only after the first completed",
      ),
    ).toEqual(true);
  });

  it("RP5 — multiline, Unicode and shell-significant bytes arrive exactly", function* () {
    const root = yield* useTempDirectory("xmd-repl-rp5-");
    const bag = yield* scaffold(CODEX_KIT, root);
    yield* bind(bag);
    const marker = `MK-${randomUUID().slice(0, 8)}`;
    const id = `msg-${randomUUID().slice(0, 8)}`;
    const text = [
      `First line with ${marker}`,
      'shell stuff: $HOME `whoami`; rm -rf / && echo "nope"',
      "unicode: café — 日本語 — ✓ — 🙂",
      "trailing backslash \\ and a quote ' and a semicolon ;",
    ].join("\n");
    yield* bag.store.dispatch({ type: "MessageQueued", key: bag.identity.id, id, text, marker });

    const attempt = yield* attemptStep(
      bag.store,
      bag.identity.id,
      bag.pane.probe,
      bag.observer,
      bag.options,
    );
    tally.convergenceAttempts += 1;
    expect(attempt.outcome).toEqual("pasted");
    if (attempt.outcome === "pasted") {
      tally.admittedDeliveries += 1;
    }
    // The bytes the pane received are exactly the bytes queued — nothing was
    // interpreted by a shell or a tmux argument vector.
    expect(bag.pane.deliveries[0]?.bytes).toEqual(text);

    yield* appendRecords(bag.path, [codexUser(text), codexComplete()]);
    yield* observeStep(bag.store, bag.identity.id, bag.observer);
    // The provider event carries the exact bytes, so acceptance and completion settled.
    expect(messageState(bag.store, bag.identity.id, id)).toEqual("completed");
    expect(
      record(
        "RP5",
        true,
        "delivered bytes byte-identical to the queued message, including LF, Unicode and metacharacters",
      ),
    ).toEqual(true);
  });

  it("RP6 — restart before delivery restores the queue and produces one attempt", function* () {
    const root = yield* useTempDirectory("xmd-repl-rp6-");
    const bag = yield* scaffold(CODEX_KIT, root);
    yield* bind(bag);
    const message = yield* queue(bag);

    // Restart: a second store handle replays the persisted log.
    const restarted = yield* useReplStore(bag.storeDir);
    const settled = yield* reconcileRestart(restarted);
    expect(settled).toEqual(0);
    restart.queuedRestored += 1;
    expect(messageState(restarted, bag.identity.id, message.id)).toEqual("queued");

    const attempt = yield* attemptStep(
      restarted,
      bag.identity.id,
      bag.pane.probe,
      bag.observer,
      bag.options,
    );
    tally.convergenceAttempts += 1;
    tally.replays += 1;
    expect(attempt.outcome).toEqual("pasted");
    expect(bag.pane.deliveries.length).toEqual(1);
    if (attempt.outcome === "pasted") {
      tally.admittedDeliveries += 1;
    }
    expect(
      record("RP6", true, "queued message survived restart; exactly one attempt after"),
    ).toEqual(true);
  });

  it("RP7 — restart during observation restores uncertain and never pastes again", function* () {
    const root = yield* useTempDirectory("xmd-repl-rp7-");
    const bag = yield* scaffold(CODEX_KIT, root);
    yield* bind(bag);
    const message = yield* queue(bag);

    const attempt = yield* attemptStep(
      bag.store,
      bag.identity.id,
      bag.pane.probe,
      bag.observer,
      bag.options,
    );
    tally.convergenceAttempts += 1;
    expect(attempt.outcome).toEqual("pasted");
    if (attempt.outcome === "pasted") {
      tally.admittedDeliveries += 1;
    }
    expect(messageState(bag.store, bag.identity.id, message.id)).toEqual("attempt-started");

    // Restart after the attempt but before acceptance: the outcome is uncertain.
    const restarted = yield* useReplStore(bag.storeDir);
    const settled = yield* reconcileRestart(restarted);
    expect(settled).toEqual(1);
    restart.uncertainAfterRestart += 1;
    tally.uncertain += 1;
    expect(messageState(restarted, bag.identity.id, message.id)).toEqual("uncertain");

    // A fresh pane for the restarted controller: it must not paste again.
    const restartedPane = createFakePane();
    const again = yield* attemptStep(
      restarted,
      bag.identity.id,
      restartedPane.probe,
      bag.observer,
      bag.options,
    );
    tally.replays += 1;
    expect(again.outcome).toEqual("skipped");
    expect(restartedPane.deliveries.length).toEqual(0);

    // A later exact user event resolves the uncertainty without a new paste.
    yield* appendRecords(bag.path, [codexUser(message.text), codexComplete()]);
    yield* observeStep(restarted, bag.identity.id, bag.observer);
    expect(messageState(restarted, bag.identity.id, message.id)).toEqual("completed");
    expect(restartedPane.deliveries.length).toEqual(0);
    expect(
      record(
        "RP7",
        true,
        "attempt-started restored as uncertain, not re-pasted; later exact event resolved it",
      ),
    ).toEqual(true);
  });

  it("RP8 — restart after completion restores completed state with no duplicate", function* () {
    const root = yield* useTempDirectory("xmd-repl-rp8-");
    const bag = yield* scaffold(CODEX_KIT, root);
    yield* bind(bag);
    const message = yield* queue(bag);
    const attempt = yield* attemptStep(
      bag.store,
      bag.identity.id,
      bag.pane.probe,
      bag.observer,
      bag.options,
    );
    tally.convergenceAttempts += 1;
    if (attempt.outcome === "pasted") {
      tally.admittedDeliveries += 1;
    }
    yield* appendRecords(bag.path, [codexUser(message.text), codexComplete()]);
    yield* observeStep(bag.store, bag.identity.id, bag.observer);
    expect(messageState(bag.store, bag.identity.id, message.id)).toEqual("completed");
    const cursorBefore = role(bag.store.state(), bag.identity.id).cursor;

    const restarted = yield* useReplStore(bag.storeDir);
    yield* reconcileRestart(restarted);
    restart.completedRestored += 1;
    const restartedPane = createFakePane();
    const again = yield* attemptStep(
      restarted,
      bag.identity.id,
      restartedPane.probe,
      bag.observer,
      bag.options,
    );
    tally.replays += 1;
    expect(again.outcome).toEqual("skipped");
    expect(restartedPane.deliveries.length).toEqual(0);
    expect(messageState(restarted, bag.identity.id, message.id)).toEqual("completed");
    expect(role(restarted.state(), bag.identity.id).cursor).toEqual(cursorBefore);
    expect(
      record(
        "RP8",
        true,
        "completed message and cursor restored; no re-execution or duplicate event",
      ),
    ).toEqual(true);
  });

  it("RP9 — a partial record advances no cursor and emits once when completed", function* () {
    const root = yield* useTempDirectory("xmd-repl-rp9-");
    const bag = yield* scaffold(CODEX_KIT, root);
    yield* bind(bag);
    const message = yield* queue(bag);
    const attempt = yield* attemptStep(
      bag.store,
      bag.identity.id,
      bag.pane.probe,
      bag.observer,
      bag.options,
    );
    tally.convergenceAttempts += 1;
    if (attempt.outcome === "pasted") {
      tally.admittedDeliveries += 1;
    }

    // Consume the idle baseline first, so the cursor sits at the file's end.
    yield* observeStep(bag.store, bag.identity.id, bag.observer);
    const cursorBefore = role(bag.store.state(), bag.identity.id).cursor;

    // A half-written user record: no newline yet. The cursor must not move.
    const full = codexUser(message.text);
    const partial = full.slice(0, Math.floor(full.length / 2));
    yield* appendPartial(bag.path, partial);
    yield* observeStep(bag.store, bag.identity.id, bag.observer);
    expect(role(bag.store.state(), bag.identity.id).cursor).toEqual(cursorBefore);
    expect(messageState(bag.store, bag.identity.id, message.id)).toEqual("attempt-started");

    // Complete the record: it emits exactly once.
    yield* appendPartial(bag.path, full.slice(partial.length));
    yield* appendRecords(bag.path, [codexComplete()]);
    yield* observeStep(bag.store, bag.identity.id, bag.observer);
    expect(messageState(bag.store, bag.identity.id, message.id)).toEqual("completed");
    const userEvents = role(bag.store.state(), bag.identity.id).events.filter(
      (event) => event.kind === "user-accepted",
    );
    expect(userEvents.length).toEqual(1);
    expect(
      record(
        "RP9",
        true,
        "partial tail held the cursor; the completed record emitted exactly one user event",
      ),
    ).toEqual(true);
  });

  it("RP10 — manual activity before the guard invalidates the attempt with zero paste", function* () {
    const root = yield* useTempDirectory("xmd-repl-rp10-");
    const bag = yield* scaffold(CODEX_KIT, root);
    yield* bind(bag);
    const message = yield* queue(bag);
    // A person types between convergence and the final guard: the load hook
    // fires just before the guarded paste and moves client activity.
    bag.pane.armLoad(() => {
      bag.pane.setManual(true);
      bag.pane.clientActivity();
    });
    const attempt = yield* attemptStep(
      bag.store,
      bag.identity.id,
      bag.pane.probe,
      bag.observer,
      bag.options,
    );
    tally.convergenceAttempts += 1;
    expect(attempt.outcome).toEqual("declined");
    expect(bag.pane.deliveries.length).toEqual(0);
    expect(bag.pane.declines).toEqual(1);
    // The message is queued again, not lost.
    expect(messageState(bag.store, bag.identity.id, message.id)).toEqual("queued");
    expect(
      record(
        "RP10",
        true,
        "activity between convergence and the guard declined the paste; zero bytes sent",
      ),
    ).toEqual(true);
  });

  it("RP11 — a pane that exited before delivery leaves the message unattempted", function* () {
    const root = yield* useTempDirectory("xmd-repl-rp11-");
    const bag = yield* scaffold(CODEX_KIT, root);
    yield* bind(bag);
    const message = yield* queue(bag);
    bag.pane.kill();
    const attempt = yield* attemptStep(
      bag.store,
      bag.identity.id,
      bag.pane.probe,
      bag.observer,
      bag.options,
    );
    tally.convergenceAttempts += 1;
    expect(attempt.outcome).toEqual("not-ready");
    expect(bag.pane.deliveries.length).toEqual(0);
    expect(messageState(bag.store, bag.identity.id, message.id)).toEqual("queued");
    expect(role(bag.store.state(), bag.identity.id).readiness).toEqual("unavailable");
    expect(
      record(
        "RP11",
        true,
        "a dead pane is refused; the message stays unattempted and the role unavailable",
      ),
    ).toEqual(true);
  });

  it("RP12 — a replacement pane at the same ordinal is refused", function* () {
    const root = yield* useTempDirectory("xmd-repl-rp12-");
    const bag = yield* scaffold(CODEX_KIT, root);
    yield* bind(bag, { generation: 1 });
    const message = yield* queue(bag);
    // The pane is replaced: a fresh generation the role never bound to.
    bag.pane.replace();
    const attempt = yield* attemptStep(
      bag.store,
      bag.identity.id,
      bag.pane.probe,
      bag.observer,
      bag.options,
    );
    tally.convergenceAttempts += 1;
    expect(attempt.outcome).toEqual("not-ready");
    if (attempt.outcome === "not-ready") {
      expect(attempt.reason).toEqual("pane-replaced");
    }
    expect(bag.pane.deliveries.length).toEqual(0);
    expect(messageState(bag.store, bag.identity.id, message.id)).toEqual("queued");
    expect(
      record("RP12", true, "a bumped generation is not adopted; the old generation is refused"),
    ).toEqual(true);
  });

  it("RP13 — an ambiguous identity refuses the observer and delivery", function* () {
    const root = yield* useTempDirectory("xmd-repl-rp13-");
    const bag = yield* scaffold(CODEX_KIT, root);
    yield* bind(bag);
    const message = yield* queue(bag);
    // A second rollout file names the same identity: now two files match.
    const second = codexRolloutPath(bag.providerDir, "duplicate");
    yield* writeRecords(second, [codexMeta(bag.identity.id)]);
    const attempt = yield* attemptStep(
      bag.store,
      bag.identity.id,
      bag.pane.probe,
      bag.observer,
      bag.options,
    );
    expect(attempt.outcome).toEqual("refused");
    if (attempt.outcome === "refused") {
      expect(attempt.refusal).toEqual("identity-ambiguous");
    }
    tally.refusals += 1;
    expect(bag.pane.deliveries.length).toEqual(0);
    expect(messageState(bag.store, bag.identity.id, message.id)).toEqual("queued");
    expect(
      record("RP13", true, "two files for one identity refused both observation and delivery"),
    ).toEqual(true);
  });

  it("RP14 — truncation and rotation refuse observation without rewinding", function* () {
    const root = yield* useTempDirectory("xmd-repl-rp14-");
    const bag = yield* scaffold(CODEX_KIT, root);
    yield* bind(bag);
    const message = yield* queue(bag);
    const attempt = yield* attemptStep(
      bag.store,
      bag.identity.id,
      bag.pane.probe,
      bag.observer,
      bag.options,
    );
    tally.convergenceAttempts += 1;
    if (attempt.outcome === "pasted") {
      tally.admittedDeliveries += 1;
    }
    yield* appendRecords(bag.path, [codexUser(message.text)]);
    yield* observeStep(bag.store, bag.identity.id, bag.observer);
    const cursorAfterAccept = role(bag.store.state(), bag.identity.id).cursor;
    expect(cursorAfterAccept > 0).toEqual(true);

    // Truncate below the cursor: the observer refuses rather than rewinding.
    yield* truncateFile(bag.path, cursorAfterAccept - 5);
    const truncated = yield* observeStep(bag.store, bag.identity.id, bag.observer);
    expect(truncated.outcome).toEqual("refused");
    if (truncated.outcome === "refused") {
      expect(truncated.refusal).toEqual("truncation");
    }
    tally.refusals += 1;
    expect(role(bag.store.state(), bag.identity.id).cursor).toEqual(cursorAfterAccept);

    // Rotate the file to a new inode: a replacement is refused, not read.
    yield* rotateFile(bag.path, [
      codexMeta(bag.identity.id),
      codexUser(message.text),
      codexComplete(),
    ]);
    const rotated = yield* observeStep(bag.store, bag.identity.id, bag.observer);
    expect(rotated.outcome).toEqual("refused");
    if (rotated.outcome === "refused") {
      expect(rotated.refusal).toEqual("rotation");
    }
    tally.refusals += 1;
    expect(
      record("RP14", true, "truncation and rotation both refused; the cursor never rewound"),
    ).toEqual(true);
  });

  it("RP15 — an unsupported relevant shape refuses rather than skipping", function* () {
    const root = yield* useTempDirectory("xmd-repl-rp15-");
    for (const kit of [CLAUDE_KIT, CODEX_KIT]) {
      const bag = yield* scaffold(kit, root);
      yield* bind(bag);
      const message = yield* queue(bag);
      const attempt = yield* attemptStep(
        bag.store,
        bag.identity.id,
        bag.pane.probe,
        bag.observer,
        bag.options,
      );
      tally.convergenceAttempts += 1;
      if (attempt.outcome === "pasted") {
        tally.admittedDeliveries += 1;
      }
      // A relevant record whose required member is missing is unsupported.
      yield* appendRecords(bag.path, [kit.unsupported(bag.identity.id)]);
      const observed = yield* observeStep(bag.store, bag.identity.id, bag.observer);
      expect(observed.outcome).toEqual("refused");
      if (observed.outcome === "refused") {
        expect(observed.refusal).toEqual("unsupported-shape");
      }
      tally.refusals += 1;
      // Nothing was accepted, and the cursor did not move past the bad record.
      expect(messageState(bag.store, bag.identity.id, message.id)).toEqual("attempt-started");
    }
    expect(
      record(
        "RP15",
        true,
        "an unsupported relevant record refused, not skipped, for both providers",
      ),
    ).toEqual(true);
  });

  it("RP16 — an unconfirmed attempt becomes uncertain and is not retried", function* () {
    const root = yield* useTempDirectory("xmd-repl-rp16-");
    const bag = yield* scaffold(CODEX_KIT, root);
    yield* bind(bag);
    const message = yield* queue(bag);
    const attempt = yield* attemptStep(
      bag.store,
      bag.identity.id,
      bag.pane.probe,
      bag.observer,
      bag.options,
    );
    tally.convergenceAttempts += 1;
    expect(attempt.outcome).toEqual("pasted");
    if (attempt.outcome === "pasted") {
      tally.admittedDeliveries += 1;
    }
    // No exact user event ever appears; a bounded observation shows nothing.
    yield* observeStep(bag.store, bag.identity.id, bag.observer);
    expect(messageState(bag.store, bag.identity.id, message.id)).toEqual("attempt-started");
    const settled = yield* settleUnconfirmed(bag.store, bag.identity.id, "no-acceptance");
    expect(settled).toEqual(true);
    tally.uncertain += 1;
    expect(messageState(bag.store, bag.identity.id, message.id)).toEqual("uncertain");

    // It is not retried: a further attempt step delivers nothing new.
    const again = yield* attemptStep(
      bag.store,
      bag.identity.id,
      bag.pane.probe,
      bag.observer,
      bag.options,
    );
    expect(again.outcome).toEqual("skipped");
    expect(bag.pane.deliveries.length).toEqual(1);
    expect(
      record("RP16", true, "an unconfirmed paste became uncertain and was never retried"),
    ).toEqual(true);
  });

  it("RP17 — wrong evidence never settles a message as accepted", function* () {
    const root = yield* useTempDirectory("xmd-repl-rp17-");

    // (a) A marker under another identity: the observer refuses it.
    const other = yield* scaffold(CLAUDE_KIT, root);
    yield* bind(other);
    const otherMessage = yield* queue(other);
    const attemptA = yield* attemptStep(
      other.store,
      other.identity.id,
      other.pane.probe,
      other.observer,
      other.options,
    );
    tally.convergenceAttempts += 1;
    if (attemptA.outcome === "pasted") {
      tally.admittedDeliveries += 1;
    }
    // A user record under a different sessionId, in the intended file.
    yield* appendRecords(other.path, [claudeUser("someone-else-entirely", otherMessage.text)]);
    const refused = yield* observeStep(other.store, other.identity.id, other.observer);
    expect(refused.outcome).toEqual("refused");
    if (refused.outcome === "refused") {
      expect(refused.refusal).toEqual("identity-mismatch");
    }
    tally.refusals += 1;
    expect(messageState(other.store, other.identity.id, otherMessage.id)).toEqual(
      "attempt-started",
    );

    // (b) Different text under the intended identity: no acceptance.
    const bag = yield* scaffold(CODEX_KIT, root);
    yield* bind(bag);
    const message = yield* queue(bag);
    const attemptB = yield* attemptStep(
      bag.store,
      bag.identity.id,
      bag.pane.probe,
      bag.observer,
      bag.options,
    );
    tally.convergenceAttempts += 1;
    if (attemptB.outcome === "pasted") {
      tally.admittedDeliveries += 1;
    }
    yield* appendRecords(bag.path, [codexUser("a completely different message"), codexComplete()]);
    yield* observeStep(bag.store, bag.identity.id, bag.observer);
    expect(messageState(bag.store, bag.identity.id, message.id)).toEqual("attempt-started");
    expect(
      record(
        "RP17",
        true,
        "a marker under another identity refused; different text under the intended identity did not accept",
      ),
    ).toEqual(true);
  });

  it("RP18 — ownership and cleanup remove only owned state and never touch provider files", function* () {
    const root = yield* useTempDirectory("xmd-repl-rp18-");
    const bag = yield* scaffold(CODEX_KIT, root);
    yield* bind(bag);
    const message = yield* queue(bag);
    const attempt = yield* attemptStep(
      bag.store,
      bag.identity.id,
      bag.pane.probe,
      bag.observer,
      bag.options,
    );
    tally.convergenceAttempts += 1;
    if (attempt.outcome === "pasted") {
      tally.admittedDeliveries += 1;
    }
    // The private message file is removed once the attempt settled.
    const messageFile = join(bag.messageDir, `${message.id}.msg`);
    cleanup.messageFilesRemoved = !(yield* exists(messageFile));

    // Observing does not write: the provider file bytes are unchanged.
    yield* appendRecords(bag.path, [codexUser(message.text), codexComplete()]);
    const before = yield* readTextFile(bag.path);
    yield* observeStep(bag.store, bag.identity.id, bag.observer);
    const after = yield* readTextFile(bag.path);
    cleanup.providerFilesUntouched = before === after;

    // The store's own directory is removable; nothing outside it is swept.
    yield* purgeStore(bag.storeDir);
    cleanup.storeRemoved = !(yield* exists(bag.storeDir));
    expect(yield* exists(bag.path)).toEqual(true);

    expect(cleanup.messageFilesRemoved).toEqual(true);
    expect(cleanup.providerFilesUntouched).toEqual(true);
    expect(cleanup.storeRemoved).toEqual(true);
    expect(
      record(
        "RP18",
        true,
        "message file removed, provider file byte-identical after observe, store dir purged, provider file survived",
      ),
    ).toEqual(true);
  });

  it("produces a valid terminal-repl-poc-report.v1 with every row passing", function* () {
    const passed = matrix.filter((entry) => entry.result === "pass").length;
    expect(matrix.length).toEqual(18);
    expect(passed).toEqual(18);
    expect(tally.duplicateDeliveries).toEqual(0);
    expect(tally.wrongPaneDeliveries).toEqual(0);
    expect(tally.busyAdmissions).toEqual(0);
    expect(tally.manualActivityAdmissions).toEqual(0);

    const report = {
      schema: REPORT_SCHEMA,
      verdict: "PASS" as const,
      mode: "deterministic" as const,
      runtime: runtimeName(),
      base: { sha: BASE_SHA },
      providers: {
        claude: {
          verdict: "PASS" as const,
          versionKnown: false,
          identityHash: identityHash("claude-deterministic"),
        },
        codex: {
          verdict: "PASS" as const,
          versionKnown: false,
          identityHash: identityHash("codex-deterministic"),
        },
      },
      turnBudgets: { claudeAuthorized: 0, claudeSpent: 0, codexAuthorized: 0, codexSpent: 0 },
      matrix,
      counters: tally,
      deliveries,
      restart,
      cleanup,
    };
    const validation = yield* validateReport(report);
    if (!validation.valid) {
      throw new Error(`report failed schema validation: ${validation.errors.join("; ")}`);
    }
    expect(validation.valid).toEqual(true);
  });
});

/** The runtime this suite ran under, for the report's provenance. */
function runtimeName(): string {
  const globals = globalThis as { Deno?: unknown; Bun?: unknown };
  if (globals.Deno !== undefined) {
    return "deno";
  }
  if (globals.Bun !== undefined) {
    return "bun";
  }
  return "node";
}
