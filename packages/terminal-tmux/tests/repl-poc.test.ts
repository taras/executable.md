/**
 * Issue #774 POC — the deterministic evidence for black-box REPL messaging.
 *
 * This suite freezes RP1–RP18 from the plan and proves them without a real agent
 * or a real tmux. A fake pane supplies the structural convergence facts the
 * algorithm reads, and synthetic append-only files supply the provider evidence
 * the observer reads. The fake also holds the hidden truth — actually busy,
 * actually typed-into — that only these assertions see, so a paste admitted while
 * either was true is caught, and it models the two ways the final guard can go
 * wrong on a real server (a declined command and an unacknowledged submit).
 *
 * Beyond the frozen matrix, supporting rows exercise the boundaries the live
 * worker relies on: provider state folded into convergence, the guard's command
 * outcome, project-scoped location, turn grouping, per-provider authorization,
 * strict persisted-action parsing, and the report's PASS gate.
 *
 * Every success is a parsed record, an explicit event, or a counted delivery;
 * elapsed time proves nothing here. The suite is portable — no tmux, no CLI
 * subprocess, no runtime-specific API — so it runs under Deno, Node and Bun.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { useTempDirectory } from "@executablemd/test-support/temp";
import { ensureDir, exists, readTextFile, writeTextFile } from "@effectionx/fs";
import { chmod } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { race, spawn, suspend, until } from "effection";
import type { Operation } from "effection";
import {
  attemptStep,
  observeStep,
  reconcileRestart,
  settleUnconfirmed,
} from "../poc/repl/controller.ts";
import type { DeliveryOptions, ObserverSource } from "../poc/repl/controller.ts";
import { withPreparedDelivery } from "../poc/repl/delivery.ts";
import { purgeStore, ReplStoreError, useReplStore } from "../poc/repl/store.ts";
import type { ReplStore } from "../poc/repl/store.ts";
import { claudeParser, createClaudeParser } from "../poc/repl/claude-observer.ts";
import { codexParser } from "../poc/repl/codex-observer.ts";
import { runLiveProof, viewOnlyCloseout } from "../poc/repl/live-supervisor.ts";
import { paneProbeOver } from "../poc/repl/live-worker.ts";
import type { PaneActivity, TmuxCommand } from "../poc/repl/live-worker.ts";
import type { Provider, ReplState } from "../poc/repl/state.ts";
import type { ProviderParser } from "../poc/repl/observer.ts";
import {
  aggregateReport,
  countersSafe,
  decideProviderVerdict,
  identityHash,
  REPORT_SCHEMA,
  validateReport,
  zeroCounters,
} from "../poc/repl/report.ts";
import type {
  DeliveryEvidence,
  MatrixEntry,
  ReportCounters,
  RestartEvidence,
  TerminalReplReport,
} from "../poc/repl/report.ts";
import {
  appendPartial,
  appendRecords,
  claudeAssistant,
  claudeResult,
  claudeSessionPath,
  claudeUnsupported,
  claudeUser,
  codexAgent,
  codexComplete,
  codexMeta,
  codexRolloutPath,
  codexUnsupported,
  codexUser,
  createFakePane,
  rotateFile,
  truncateFile,
  writeRecords,
} from "./fixtures/repl-poc/fake-terminal.ts";
import type { FakePane } from "./fixtures/repl-poc/fake-terminal.ts";

/** The exact base the POC was implemented from, recorded in the report. */
const BASE_SHA = "97fda6aa7b5f85db747c066898fd3ef3c6d1dbeb";
/** A representative head, only for proving the schema accepts a full PASS. */
const HEAD_SHA = "0123456789abcdef0123456789abcdef01234567";

/** One provider's record shapes, so a scenario can run against either agent. */
interface ProviderKit {
  readonly provider: Provider;
  readonly parser: ProviderParser;
  path(directory: string, id: string): string;
  idle(id: string, project: string): string[];
  user(id: string, text: string, turn?: string): string;
  assistant(id: string, text: string, turn?: string): string;
  complete(id: string, turn?: string): string;
  unsupported(id: string): string;
}

const CLAUDE_KIT: ProviderKit = {
  provider: "claude",
  parser: claudeParser,
  path: (directory, id) => claudeSessionPath(directory, id),
  idle: () => [],
  user: (id, text, turn) => claudeUser(id, text, turn),
  assistant: (id, text, turn) => claudeAssistant(id, text, turn),
  complete: (id, turn) => claudeResult(id, turn),
  unsupported: (id) => claudeUnsupported(id),
};

const CODEX_KIT: ProviderKit = {
  provider: "codex",
  parser: codexParser,
  path: (directory) => codexRolloutPath(directory, "main"),
  idle: (id, project) => [codexMeta(id, project)],
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
  readonly project: string;
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
    const project = join(root, `project-${suffix}`);
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
      project,
      store,
      pane,
      identity,
      observer: { parser: kit.parser, directory: providerDir, project },
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
    yield* writeRecords(bag.path, bag.kit.idle(bag.identity.id, bag.project));
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
    // Claude carries an explicit turn identity; Codex is a linear thread.
    const cases: { kit: ProviderKit; turn: string | undefined }[] = [
      { kit: CLAUDE_KIT, turn: "req-1" },
      { kit: CODEX_KIT, turn: undefined },
    ];
    for (const scenario of cases) {
      const bag = yield* scaffold(scenario.kit, root);
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
      expect(bag.pane.deliveries.length).toEqual(1);
      expect(bag.pane.deliveries[0]?.whileBusy).toEqual(false);
      expect(bag.pane.deliveries[0]?.whileManual).toEqual(false);

      yield* appendRecords(bag.path, [
        scenario.kit.user(bag.identity.id, message.text, scenario.turn),
        scenario.kit.assistant(bag.identity.id, "Working on it.", scenario.turn),
        scenario.kit.complete(bag.identity.id, scenario.turn),
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

    yield* appendRecords(claude.path, [
      claude.kit.user(claude.identity.id, claudeMessage.text, "req-c"),
      claude.kit.complete(claude.identity.id, "req-c"),
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
    const blocked = yield* attemptStep(
      bag.store,
      bag.identity.id,
      bag.pane.probe,
      bag.observer,
      bag.options,
    );
    expect(blocked.outcome).toEqual("skipped");
    expect(bag.pane.deliveries.length).toEqual(1);

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
    expect(bag.pane.deliveries[0]?.bytes).toEqual(text);

    yield* appendRecords(bag.path, [codexUser(text), codexComplete()]);
    yield* observeStep(bag.store, bag.identity.id, bag.observer);
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

    const restarted = yield* useReplStore(bag.storeDir);
    const settled = yield* reconcileRestart(restarted);
    expect(settled).toEqual(1);
    restart.uncertainAfterRestart += 1;
    tally.uncertain += 1;
    expect(messageState(restarted, bag.identity.id, message.id)).toEqual("uncertain");

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

    yield* observeStep(bag.store, bag.identity.id, bag.observer);
    const cursorBefore = role(bag.store.state(), bag.identity.id).cursor;

    const full = codexUser(message.text);
    const partial = full.slice(0, Math.floor(full.length / 2));
    yield* appendPartial(bag.path, partial);
    yield* observeStep(bag.store, bag.identity.id, bag.observer);
    expect(role(bag.store.state(), bag.identity.id).cursor).toEqual(cursorBefore);
    expect(messageState(bag.store, bag.identity.id, message.id)).toEqual("attempt-started");

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
    // A person types between convergence and the final guard, without changing
    // the pane's PID: the load hook fires just before the guarded paste.
    bag.pane.armLoad(() => {
      bag.pane.setManual(true);
      bag.pane.clientActivity();
      return until(Promise.resolve());
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
    // The final combined sample runs after the buffer is prepared, so activity
    // during preparation is caught before AttemptStarted and before the guard —
    // nothing was pasted, and the guarded paste was never even reached.
    expect(bag.pane.deliveries.length).toEqual(0);
    expect(bag.pane.declines).toEqual(0);
    expect(messageState(bag.store, bag.identity.id, message.id)).toEqual("queued");
    expect(
      record(
        "RP10",
        true,
        "same-PID manual activity while the buffer loaded declined the attempt before the guard; zero bytes sent",
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
    // A second rollout for the same identity and project: now two files match.
    const second = codexRolloutPath(bag.providerDir, "duplicate");
    yield* writeRecords(second, [codexMeta(bag.identity.id, bag.project)]);
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
      record(
        "RP13",
        true,
        "two files for one identity and project refused both observation and delivery",
      ),
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

    yield* truncateFile(bag.path, cursorAfterAccept - 5);
    const truncated = yield* observeStep(bag.store, bag.identity.id, bag.observer);
    expect(truncated.outcome).toEqual("refused");
    if (truncated.outcome === "refused") {
      expect(truncated.refusal).toEqual("truncation");
    }
    tally.refusals += 1;
    expect(role(bag.store.state(), bag.identity.id).cursor).toEqual(cursorAfterAccept);

    yield* rotateFile(bag.path, [
      codexMeta(bag.identity.id, bag.project),
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
      yield* appendRecords(bag.path, [kit.unsupported(bag.identity.id)]);
      const observed = yield* observeStep(bag.store, bag.identity.id, bag.observer);
      expect(observed.outcome).toEqual("refused");
      if (observed.outcome === "refused") {
        expect(observed.refusal).toEqual("unsupported-shape");
      }
      tally.refusals += 1;
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
    yield* observeStep(bag.store, bag.identity.id, bag.observer);
    expect(messageState(bag.store, bag.identity.id, message.id)).toEqual("attempt-started");
    const settled = yield* settleUnconfirmed(bag.store, bag.identity.id, "no-acceptance");
    expect(settled).toEqual(true);
    tally.uncertain += 1;
    expect(messageState(bag.store, bag.identity.id, message.id)).toEqual("uncertain");

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
    yield* appendRecords(other.path, [
      claudeUser("someone-else-entirely", otherMessage.text, "req-x"),
    ]);
    const refused = yield* observeStep(other.store, other.identity.id, other.observer);
    expect(refused.outcome).toEqual("refused");
    if (refused.outcome === "refused") {
      expect(refused.refusal).toEqual("identity-mismatch");
    }
    tally.refusals += 1;
    expect(messageState(other.store, other.identity.id, otherMessage.id)).toEqual(
      "attempt-started",
    );

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

  it("RP18 — ownership and cleanup remove owned state across success, cancellation and partial acquisition", function* () {
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
    // On success, the private message file and the tmux buffer are both gone.
    const messageFile = join(bag.messageDir, `${message.id}.msg`);
    cleanup.messageFilesRemoved = !(yield* exists(messageFile));
    expect(bag.pane.pendingBuffers()).toEqual(0);

    // A declined attempt (partial acquisition: file written, guard declined)
    // still removes the file and the buffer.
    const second = yield* queue(bag);
    yield* appendRecords(bag.path, [codexUser(message.text), codexComplete()]);
    yield* observeStep(bag.store, bag.identity.id, bag.observer);
    bag.pane.armGuardFailure("declined");
    const declined = yield* attemptStep(
      bag.store,
      bag.identity.id,
      bag.pane.probe,
      bag.observer,
      bag.options,
    );
    tally.convergenceAttempts += 1;
    expect(declined.outcome).toEqual("declined");
    expect(yield* exists(join(bag.messageDir, `${second.id}.msg`))).toEqual(false);
    expect(bag.pane.pendingBuffers()).toEqual(0);

    // Observing does not write: the provider file bytes are unchanged.
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
        "message file and buffer removed on success and on a declined partial attempt; provider file byte-identical; store purged; provider file survived",
      ),
    ).toEqual(true);
  });

  // --- Supporting rows for the boundaries the live worker relies on ------------

  it("provider state is part of convergence: a turn opening during the barrier refuses", function* () {
    const root = yield* useTempDirectory("xmd-repl-barrier-");
    const bag = yield* scaffold(CODEX_KIT, root);
    yield* bind(bag);
    const message = yield* queue(bag);
    // A provider turn appears during the acknowledged barrier, exactly the race
    // the Architect reported. Convergence samples the provider after the barrier
    // and must refuse rather than paste.
    bag.pane.armBarrier(() =>
      appendRecords(bag.path, [codexUser("an interleaved turn"), codexAgent("busy")]),
    );
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
    expect(bag.pane.deliveries.every((delivery) => !delivery.whileBusy)).toEqual(true);
    expect(messageState(bag.store, bag.identity.id, message.id)).toEqual("queued");
  });

  it("pane output or a mode change during the barrier refuses", function* () {
    const root = yield* useTempDirectory("xmd-repl-panechange-");
    for (const disturb of [
      (pane: FakePane) => pane.output(),
      (pane: FakePane) => pane.setMode("copy"),
    ]) {
      const bag = yield* scaffold(CODEX_KIT, root);
      yield* bind(bag);
      yield* queue(bag);
      bag.pane.armBarrier(() => {
        disturb(bag.pane);
        return until(Promise.resolve());
      });
      const attempt = yield* attemptStep(
        bag.store,
        bag.identity.id,
        bag.pane.probe,
        bag.observer,
        bag.options,
      );
      expect(attempt.outcome).toEqual("not-ready");
      expect(bag.pane.deliveries.length).toEqual(0);
    }
  });

  it("the guard's command outcome is honored: a failed command declines, an unacknowledged submit is uncertain", function* () {
    const root = yield* useTempDirectory("xmd-repl-guard-");
    const declinedBag = yield* scaffold(CODEX_KIT, root);
    yield* bind(declinedBag);
    const first = yield* queue(declinedBag);
    declinedBag.pane.armGuardFailure("declined");
    const declined = yield* attemptStep(
      declinedBag.store,
      declinedBag.identity.id,
      declinedBag.pane.probe,
      declinedBag.observer,
      declinedBag.options,
    );
    expect(declined.outcome).toEqual("declined");
    expect(declinedBag.pane.deliveries.length).toEqual(0);
    expect(messageState(declinedBag.store, declinedBag.identity.id, first.id)).toEqual("queued");

    const uncertainBag = yield* scaffold(CODEX_KIT, root);
    yield* bind(uncertainBag);
    const second = yield* queue(uncertainBag);
    uncertainBag.pane.armGuardFailure("uncertain");
    const uncertain = yield* attemptStep(
      uncertainBag.store,
      uncertainBag.identity.id,
      uncertainBag.pane.probe,
      uncertainBag.observer,
      uncertainBag.options,
    );
    expect(uncertain.outcome).toEqual("uncertain");
    expect(uncertainBag.pane.deliveries.length).toEqual(0);
    expect(messageState(uncertainBag.store, uncertainBag.identity.id, second.id)).toEqual(
      "uncertain",
    );
    // Not retried.
    const again = yield* attemptStep(
      uncertainBag.store,
      uncertainBag.identity.id,
      uncertainBag.pane.probe,
      uncertainBag.observer,
      uncertainBag.options,
    );
    expect(again.outcome).toEqual("skipped");
  });

  it("a source under the wrong project is not located", function* () {
    const root = yield* useTempDirectory("xmd-repl-project-");
    const bag = yield* scaffold(CODEX_KIT, root);
    yield* bind(bag);
    yield* queue(bag);
    // The only file for this identity names a different project.
    yield* writeRecords(bag.path, [codexMeta(bag.identity.id, `${bag.project}-elsewhere`)]);
    const attempt = yield* attemptStep(
      bag.store,
      bag.identity.id,
      bag.pane.probe,
      bag.observer,
      bag.options,
    );
    expect(attempt.outcome).toEqual("refused");
    if (attempt.outcome === "refused") {
      expect(attempt.refusal).toEqual("not-found");
    }
    expect(bag.pane.deliveries.length).toEqual(0);
  });

  it("Claude output and completion are grouped by turn identity", function* () {
    const root = yield* useTempDirectory("xmd-repl-turn-");
    const bag = yield* scaffold(CLAUDE_KIT, root);
    yield* bind(bag);
    const message = yield* queue(bag);
    const attempt = yield* attemptStep(
      bag.store,
      bag.identity.id,
      bag.pane.probe,
      bag.observer,
      bag.options,
    );
    expect(attempt.outcome).toEqual("pasted");
    // Accept under turn "t1"; a stray assistant output under "t2" must not be
    // attributed to it, and only the "t1" completion completes the message.
    yield* appendRecords(bag.path, [
      claudeUser(bag.identity.id, message.text, "t1"),
      claudeAssistant(bag.identity.id, "unrelated other turn", "t2"),
      claudeAssistant(bag.identity.id, "the real answer", "t1"),
      claudeResult(bag.identity.id, "t1"),
    ]);
    yield* observeStep(bag.store, bag.identity.id, bag.observer);
    expect(messageState(bag.store, bag.identity.id, message.id)).toEqual("completed");
    const events = role(bag.store.state(), bag.identity.id).events;
    const strayAttributed = events.some(
      (event) => event.kind === "assistant-output" && event.turn === "t2",
    );
    expect(strayAttributed).toEqual(false);
  });

  it("the live delivery journey is permanently disabled at the VIEW_ONLY closeout", function* () {
    // Under any environment — including both gates set — the supervisor launches
    // nothing and returns the VIEW_ONLY conclusion. Reliable dispatch stays
    // ACP-owned; there is no authorization that runs a delivery.
    const armed = {
      XMD_TERMINAL_REPL_CLAUDE_PROOF: "1",
      XMD_TERMINAL_REPL_CLAUDE_MODEL_TURNS_AUTHORIZED: "1",
      XMD_TERMINAL_REPL_CODEX_PROOF: "1",
      XMD_TERMINAL_REPL_CODEX_MODEL_TURNS_AUTHORIZED: "2",
    };
    for (const provider of ["claude", "codex"] as const) {
      const report = yield* runLiveProof(provider, armed, BASE_SHA);
      expect(report.verdict).toEqual("VIEW_ONLY");
      expect(report.turnBudgets.claudeSpent).toEqual(0);
      expect(report.turnBudgets.codexSpent).toEqual(0);
      expect((yield* validateReport(report)).valid).toEqual(true);
    }
  });

  it("a provider turn opening while the buffer loads refuses before the guard", function* () {
    const root = yield* useTempDirectory("xmd-repl-loadseam-");
    const bag = yield* scaffold(CODEX_KIT, root);
    yield* bind(bag);
    const message = yield* queue(bag);
    // A complete provider turn is appended from the buffer-load seam — during
    // preparation, after convergence. The final combined sample taken after
    // preparation must catch it, so nothing is pasted.
    bag.pane.armLoad(() =>
      appendRecords(bag.path, [codexUser("an interleaved turn"), codexAgent("busy")]),
    );
    const attempt = yield* attemptStep(
      bag.store,
      bag.identity.id,
      bag.pane.probe,
      bag.observer,
      bag.options,
    );
    expect(attempt.outcome).toEqual("declined");
    expect(bag.pane.deliveries.length).toEqual(0);
    expect(bag.pane.deliveries.every((delivery) => !delivery.whileBusy)).toEqual(true);
    expect(messageState(bag.store, bag.identity.id, message.id)).toEqual("queued");
  });

  it("a partial provider record during the barrier refuses", function* () {
    const root = yield* useTempDirectory("xmd-repl-partialbarrier-");
    const bag = yield* scaffold(CODEX_KIT, root);
    yield* bind(bag);
    const message = yield* queue(bag);
    // A record still being written — no newline yet — grows the file physically
    // without changing the cursor or the event count. Physical growth is part of
    // the sample, so convergence refuses rather than pasting into a turn opening.
    const fragment = codexUser("half a turn").slice(0, 12);
    bag.pane.armBarrier(() => appendPartial(bag.path, fragment));
    const attempt = yield* attemptStep(
      bag.store,
      bag.identity.id,
      bag.pane.probe,
      bag.observer,
      bag.options,
    );
    expect(attempt.outcome).toEqual("not-ready");
    expect(bag.pane.deliveries.length).toEqual(0);
    expect(messageState(bag.store, bag.identity.id, message.id)).toEqual("queued");
  });

  it("a Codex header without a project is refused, not accepted", function* () {
    const root = yield* useTempDirectory("xmd-repl-nocwd-");
    const bag = yield* scaffold(CODEX_KIT, root);
    yield* bind(bag);
    yield* queue(bag);
    // The only file for this identity declares no project. A required project the
    // header does not carry fails closed rather than being accepted.
    yield* writeRecords(bag.path, [codexMeta(bag.identity.id)]);
    const attempt = yield* attemptStep(
      bag.store,
      bag.identity.id,
      bag.pane.probe,
      bag.observer,
      bag.options,
    );
    expect(attempt.outcome).toEqual("refused");
    if (attempt.outcome === "refused") {
      expect(attempt.refusal).toEqual("not-found");
    }
    expect(bag.pane.deliveries.length).toEqual(0);
  });

  it("a Claude record without a turn identity refuses observation", function* () {
    const root = yield* useTempDirectory("xmd-repl-noturn-");
    const bag = yield* scaffold(CLAUDE_KIT, root);
    yield* bind(bag);
    const message = yield* queue(bag);
    const attempt = yield* attemptStep(
      bag.store,
      bag.identity.id,
      bag.pane.probe,
      bag.observer,
      bag.options,
    );
    expect(attempt.outcome).toEqual("pasted");
    // A user record carrying no requestId turn identity cannot be grouped, so it
    // is an unsupported shape rather than a silent match.
    yield* appendRecords(bag.path, [claudeUser(bag.identity.id, message.text)]);
    const observed = yield* observeStep(bag.store, bag.identity.id, bag.observer);
    expect(observed.outcome).toEqual("refused");
    if (observed.outcome === "refused") {
      expect(observed.refusal).toEqual("unsupported-shape");
    }
    expect(messageState(bag.store, bag.identity.id, message.id)).toEqual("attempt-started");
  });

  it("a missing Claude completion record is PROVIDER_EXCLUDED from capability, not a deadline", function* () {
    // The decision is made from the explicit capability, never from elapsed time.
    expect(
      decideProviderVerdict({
        accepted: true,
        completed: false,
        safe: true,
        supportsCompletion: false,
      }),
    ).toEqual("PROVIDER_EXCLUDED");
    expect(
      decideProviderVerdict({
        accepted: true,
        completed: false,
        safe: true,
        supportsCompletion: true,
      }),
    ).toEqual("VIEW_ONLY");
    expect(
      decideProviderVerdict({
        accepted: true,
        completed: true,
        safe: true,
        supportsCompletion: true,
      }),
    ).toEqual("PASS");
    expect(
      decideProviderVerdict({
        accepted: true,
        completed: true,
        safe: false,
        supportsCompletion: true,
      }),
    ).toEqual("VIEW_ONLY");

    // And a build whose format lacks the closing record never yields a
    // completion: an accepted turn stays accepted, never spuriously completed.
    const root = yield* useTempDirectory("xmd-repl-excluded-");
    const bag = yield* scaffold(CLAUDE_KIT, root);
    yield* bind(bag);
    const message = yield* queue(bag);
    const attempt = yield* attemptStep(
      bag.store,
      bag.identity.id,
      bag.pane.probe,
      bag.observer,
      bag.options,
    );
    expect(attempt.outcome).toEqual("pasted");
    const noCompletion: ObserverSource = {
      parser: createClaudeParser(false),
      directory: bag.providerDir,
      project: bag.project,
    };
    yield* appendRecords(bag.path, [
      claudeUser(bag.identity.id, message.text, "t1"),
      claudeAssistant(bag.identity.id, "the answer", "t1"),
      claudeResult(bag.identity.id, "t1"),
    ]);
    yield* observeStep(bag.store, bag.identity.id, noCompletion);
    expect(messageState(bag.store, bag.identity.id, message.id)).toEqual("accepted");
    expect(noCompletion.parser.supportsCompletion).toEqual(false);
  });

  it("a cancelled delivery removes its private file and buffer", function* () {
    const root = yield* useTempDirectory("xmd-repl-cancel-");
    const bag = yield* scaffold(CODEX_KIT, root);
    const id = "cancel-msg";
    const path = join(bag.messageDir, `${id}.msg`);
    // The delivery prepares its file and buffer, then suspends before pasting.
    // Halting the scope must run its finalizers: the file and the buffer go.
    yield* race([
      withPreparedDelivery(
        bag.pane.probe,
        { dir: bag.messageDir, id, bytes: "cancel me", bracketedPaste: true, submitKey: "Enter" },
        function* (): Operation<void> {
          yield* suspend();
        },
      ),
      (function* (): Operation<void> {
        return;
      })(),
    ]);
    expect(yield* exists(path)).toEqual(false);
    expect(bag.pane.pendingBuffers()).toEqual(0);
    expect(bag.pane.deliveries.length).toEqual(0);
  });

  it("the report schema rejects an unsafe, uncleaned or re-executed PASS", function* () {
    const claudePass = livePassReport("claude", "2.1.263");
    expect((yield* validateReport(claudePass)).valid).toEqual(true);

    const unsafe: TerminalReplReport = {
      ...claudePass,
      counters: { ...zeroCounters(), busyAdmissions: 1 },
    };
    expect((yield* validateReport(unsafe)).valid).toEqual(false);

    const dirty: TerminalReplReport = {
      ...claudePass,
      cleanup: { storeRemoved: false, messageFilesRemoved: true, providerFilesUntouched: true },
    };
    expect((yield* validateReport(dirty)).valid).toEqual(false);

    const reexecuted: TerminalReplReport = {
      ...claudePass,
      restart: {
        queuedRestored: 0,
        uncertainAfterRestart: 0,
        completedRestored: 0,
        reExecutions: 1,
      },
    };
    expect((yield* validateReport(reexecuted)).valid).toEqual(false);
  });

  it("an overall PASS requires the full matrix and both provider journeys", function* () {
    const fullMatrix: MatrixEntry[] = Array.from({ length: 18 }, (_, index) => ({
      id: `RP${index + 1}`,
      result: "pass" as const,
      evidence: "aggregated",
    }));
    const cleanCleanup = {
      storeRemoved: true,
      messageFilesRemoved: true,
      providerFilesUntouched: true,
    };
    const noRestart = {
      queuedRestored: 0,
      uncertainAfterRestart: 0,
      completedRestored: 0,
      reExecutions: 0,
    };
    const deterministic = {
      matrix: fullMatrix,
      counters: zeroCounters(),
      restart: noRestart,
      cleanup: cleanCleanup,
      deliveries: [{ messageHash: identityHash("m"), byteCount: 4 }],
    };
    const overall = aggregateReport(
      { sha: BASE_SHA },
      { sha: HEAD_SHA },
      "deno",
      deterministic,
      livePassReport("claude", "2.1.263"),
      livePassReport("codex", "codex-cli 0.153.4"),
    );
    expect(overall.verdict).toEqual("PASS");
    expect(overall.mode).toEqual("overall");
    expect(countersSafe(overall.counters)).toEqual(true);
    expect((yield* validateReport(overall)).valid).toEqual(true);

    // One provider short of PASS can never make the whole POC pass.
    const viewOnlyCodex: TerminalReplReport = {
      ...livePassReport("codex", "codex-cli 0.153.4"),
      verdict: "VIEW_ONLY",
      providers: {
        claude: { verdict: "n/a", versionKnown: false },
        codex: { verdict: "VIEW_ONLY", versionKnown: true, version: "codex-cli 0.153.4" },
      },
    };
    const partial = aggregateReport(
      { sha: BASE_SHA },
      { sha: HEAD_SHA },
      "deno",
      deterministic,
      livePassReport("claude", "2.1.263"),
      viewOnlyCodex,
    );
    expect(partial.verdict).not.toEqual("PASS");

    // An incomplete matrix can never make it pass either.
    const shortMatrix = aggregateReport(
      { sha: BASE_SHA },
      { sha: HEAD_SHA },
      "deno",
      { ...deterministic, matrix: fullMatrix.slice(0, 17) },
      livePassReport("claude", "2.1.263"),
      livePassReport("codex", "codex-cli 0.153.4"),
    );
    expect(shortMatrix.verdict).not.toEqual("PASS");
  });

  it("the live tmux probe reads real activity generations and honors one conditional guard", function* () {
    // A fake tmux command seam and a fake activity source drive the *live* probe,
    // so the boundary the live worker uses is held to the same guard contract as
    // the fake pane — without a real server.
    const issued: string[][] = [];
    const activity: PaneActivity = {
      // deno-lint-ignore require-yield
      *read() {
        return { outputEvents: 5, clientActivity: 3 };
      },
    };
    const makeRun =
      (mode: "pass" | "decline" | "fail" | "unack"): TmuxCommand =>
      (args) =>
        (function* () {
          issued.push([...args]);
          if (args[0] === "display") {
            // A pane snapshot: alive, generation %7, pid 4321, ordinary mode.
            return { code: 0, stdout: "%7|4321|ttys7|0|0|node" };
          }
          if (args[0] === "if-shell") {
            const success = args[3] ?? "";
            const nonce = success.slice(success.lastIndexOf(" ") + 1);
            if (mode === "pass") {
              return { code: 0, stdout: nonce };
            }
            if (mode === "decline") {
              return { code: 0, stdout: "DECLINED" };
            }
            if (mode === "fail") {
              return { code: 1, stdout: "" };
            }
            return { code: 0, stdout: "ran-but-no-marker" };
          }
          return { code: 0, stdout: "" };
        })();

    const guardOf = () => ({
      generation: 7,
      pid: 4321,
      terminal: "ttys7",
      alive: true,
      mode: "",
      foregroundProcess: 0,
      clientActivity: 3,
      outputEvents: 5,
      epoch: 8,
    });

    // The snapshot's activity comes from the source, not a history size, and the
    // epoch is their sum.
    const passProbe = paneProbeOver(makeRun("pass"), "xmd:0.0", activity);
    const snap = yield* passProbe.snapshot();
    expect(snap.outputEvents).toEqual(5);
    expect(snap.clientActivity).toEqual(3);
    expect(snap.epoch).toEqual(8);
    expect(snap.generation).toEqual(7);

    // A matching, acknowledged conditional pastes.
    yield* passProbe.loadBuffer("buf", "/dev/null");
    const pasted = yield* passProbe.guardedPaste(guardOf(), {
      buffer: "buf",
      bracketedPaste: true,
      submitKey: "Enter",
    });
    expect(pasted.outcome).toEqual("pasted");

    // The single conditional carries every required fact, not the PID alone.
    const conditional = issued.find((command) => command[0] === "if-shell");
    const condition = conditional?.[2] ?? "";
    for (const fact of ["pane_id", "pane_pid", "pane_dead", "pane_in_mode"]) {
      expect(condition.includes(fact)).toEqual(true);
    }

    // The server rejecting the condition declines; a failed command and an
    // unacknowledged submit are both uncertain, never pasted-as-proved.
    const declined = yield* paneProbeOver(makeRun("decline"), "xmd:0.0", activity).guardedPaste(
      guardOf(),
      { buffer: "buf", bracketedPaste: true, submitKey: "Enter" },
    );
    expect(declined.outcome).toEqual("declined");
    const failed = yield* paneProbeOver(makeRun("fail"), "xmd:0.0", activity).guardedPaste(
      guardOf(),
      {
        buffer: "buf",
        bracketedPaste: true,
        submitKey: "Enter",
      },
    );
    expect(failed.outcome).toEqual("uncertain");
    const unacked = yield* paneProbeOver(makeRun("unack"), "xmd:0.0", activity).guardedPaste(
      guardOf(),
      { buffer: "buf", bracketedPaste: true, submitKey: "Enter" },
    );
    expect(unacked.outcome).toEqual("uncertain");
  });

  it("the store refuses malformed, mislabeled, gapped, duplicated and conflicting histories", function* () {
    const root = yield* useTempDirectory("xmd-repl-store-");
    const write = (dir: string, name: string, body: unknown): Operation<void> =>
      (function* (): Operation<void> {
        yield* ensureDir(dir);
        yield* writeTextFile(join(dir, name), `${JSON.stringify(body)}\n`);
      })();
    const refuses = (dir: string): Operation<boolean> =>
      (function* (): Operation<boolean> {
        try {
          yield* useReplStore(dir);
          return false;
        } catch (error) {
          return error instanceof ReplStoreError;
        }
      })();

    // A known action missing a required member.
    const malformed = join(root, "malformed");
    yield* write(malformed, "000000.json", { seq: 0, action: { type: "RoleBound" } });
    expect(yield* refuses(malformed)).toEqual(true);

    // The file name disagrees with the record's sequence number.
    const mislabeled = join(root, "mislabeled");
    yield* write(mislabeled, "000005.json", { seq: 0, action: { type: "ReplClosed" } });
    expect(yield* refuses(mislabeled)).toEqual(true);

    // A gap: sequence 0 then 2, no 1.
    const gapped = join(root, "gapped");
    yield* write(gapped, "000000.json", { seq: 0, action: { type: "ReplClosed" } });
    yield* write(gapped, "000002.json", { seq: 2, action: { type: "ReplClosed" } });
    expect(yield* refuses(gapped)).toEqual(true);

    // An unknown action type.
    const unknown = join(root, "unknown");
    yield* write(unknown, "000000.json", { seq: 0, action: { type: "NotARealAction" } });
    expect(yield* refuses(unknown)).toEqual(true);

    // A conflicting transition: an AttemptStarted for a message never queued.
    const conflicting = join(root, "conflicting");
    yield* write(conflicting, "000000.json", {
      seq: 0,
      action: {
        type: "RoleBound",
        key: "k",
        role: "Implementor",
        issue: "#774",
        identity: { provider: "codex", id: "x" },
        paneGeneration: 1,
      },
    });
    yield* write(conflicting, "000001.json", {
      seq: 1,
      action: { type: "AttemptStarted", key: "k", id: "never-queued" },
    });
    expect(yield* refuses(conflicting)).toEqual(true);
  });

  it("a restart interleaved between the user event and its completion resolves once", function* () {
    const root = yield* useTempDirectory("xmd-repl-interleave-");
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
    expect(attempt.outcome).toEqual("pasted");

    // The user event lands; the observer records acceptance; then the process
    // restarts before the completion is appended.
    yield* appendRecords(bag.path, [codexUser(message.text)]);
    yield* observeStep(bag.store, bag.identity.id, bag.observer);
    expect(messageState(bag.store, bag.identity.id, message.id)).toEqual("accepted");

    const restarted = yield* useReplStore(bag.storeDir);
    yield* reconcileRestart(restarted);
    tally.replays += 1;
    // Accepted work is not disturbed by restart, and is not re-attempted.
    expect(messageState(restarted, bag.identity.id, message.id)).toEqual("accepted");
    const restartedPane = createFakePane();
    const again = yield* attemptStep(
      restarted,
      bag.identity.id,
      restartedPane.probe,
      bag.observer,
      bag.options,
    );
    expect(again.outcome).toEqual("skipped");
    expect(restartedPane.deliveries.length).toEqual(0);

    // The completion arrives after restart; it completes exactly once.
    yield* appendRecords(bag.path, [codexComplete()]);
    yield* observeStep(restarted, bag.identity.id, bag.observer);
    expect(messageState(restarted, bag.identity.id, message.id)).toEqual("completed");
    const completions = role(restarted.state(), bag.identity.id).events.filter(
      (event) => event.kind === "turn-completed",
    );
    expect(completions.length).toEqual(1);
  });

  it("the report schema accepts a provider PASS and rejects an incomplete one", function* () {
    const passProvider = (agent: string) => ({
      verdict: "PASS" as const,
      versionKnown: true,
      version: agent,
      identityHash: identityHash(`${agent}-identity`),
      sourceIdentityHash: identityHash(`${agent}-source`),
      accepted: true,
      completed: true,
    });
    // A single-provider live journey attests its own provider; the gate for
    // `live-claude` requires Claude's full evidence and a spent turn.
    const claudePass: TerminalReplReport = {
      schema: REPORT_SCHEMA,
      verdict: "PASS",
      mode: "live-claude",
      runtime: "deno",
      base: { sha: BASE_SHA },
      head: { sha: HEAD_SHA },
      providers: {
        claude: passProvider("2.1.263"),
        codex: { verdict: "n/a", versionKnown: false },
      },
      turnBudgets: { claudeAuthorized: 1, claudeSpent: 1, codexAuthorized: 0, codexSpent: 0 },
      matrix: [],
      counters: tally,
      deliveries,
      restart,
      cleanup: { storeRemoved: true, messageFilesRemoved: true, providerFilesUntouched: true },
    };
    expect((yield* validateReport(claudePass)).valid).toEqual(true);

    // Each of these is a Claude PASS missing a piece of the proof it requires.
    const noHead = { ...claudePass };
    delete (noHead as { head?: unknown }).head;
    expect((yield* validateReport(noHead)).valid).toEqual(false);

    const noClaudeTurn = {
      ...claudePass,
      turnBudgets: { ...claudePass.turnBudgets, claudeSpent: 0 },
    };
    expect((yield* validateReport(noClaudeTurn)).valid).toEqual(false);

    const claudeNotAccepted = {
      ...claudePass,
      providers: {
        ...claudePass.providers,
        claude: { ...passProvider("2.1.263"), accepted: false },
      },
    };
    expect((yield* validateReport(claudeNotAccepted)).valid).toEqual(false);

    const claudeNoVersion = {
      ...claudePass,
      providers: {
        ...claudePass.providers,
        claude: {
          verdict: "PASS" as const,
          versionKnown: true,
          identityHash: identityHash("c-identity"),
          sourceIdentityHash: identityHash("c-source"),
          accepted: true,
          completed: true,
        },
      },
    };
    expect((yield* validateReport(claudeNoVersion)).valid).toEqual(false);

    const noDeliveries = { ...claudePass, deliveries: [] };
    expect((yield* validateReport(noDeliveries)).valid).toEqual(false);

    const forbiddenField = { ...claudePass, secret: "leak" };
    expect((yield* validateReport(forbiddenField)).valid).toEqual(false);
  });
  it("records the VIEW_ONLY conclusion in a valid overall report", function* () {
    const passed = matrix.filter((entry) => entry.result === "pass").length;
    expect(matrix.length).toEqual(18);
    expect(passed).toEqual(18);
    expect(countersSafe(tally)).toEqual(true);

    // The POC's decision is VIEW_ONLY: the offline matrix passed, but reliable
    // dispatch is not established, so neither provider's live journey passes and
    // the overall verdict is VIEW_ONLY rather than PASS.
    const overall = aggregateReport(
      { sha: BASE_SHA },
      { sha: HEAD_SHA },
      runtimeName(),
      { matrix, counters: tally, restart, cleanup, deliveries },
      viewOnlyCloseout("claude", BASE_SHA),
      viewOnlyCloseout("codex", BASE_SHA),
    );
    expect(overall.verdict).toEqual("VIEW_ONLY");
    expect(overall.mode).toEqual("overall");
    const validation = yield* validateReport(overall);
    if (!validation.valid) {
      throw new Error(`report failed schema validation: ${validation.errors.join("; ")}`);
    }
    expect(validation.valid).toEqual(true);
    // The exact race is recorded in the closeout detail.
    expect(viewOnlyCloseout("claude", BASE_SHA).detail?.includes("VIEW_ONLY")).toEqual(true);
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

/** A valid single-provider live PASS report, for schema and aggregator rows. */
function livePassReport(provider: "claude" | "codex", version: string): TerminalReplReport {
  const pass = {
    verdict: "PASS" as const,
    versionKnown: true,
    version,
    identityHash: identityHash(`${provider}-identity`),
    sourceIdentityHash: identityHash(`${provider}-source`),
    accepted: true,
    completed: true,
  };
  const absent = { verdict: "n/a" as const, versionKnown: false };
  return {
    schema: REPORT_SCHEMA,
    verdict: "PASS",
    mode: provider === "claude" ? "live-claude" : "live-codex",
    runtime: "deno",
    base: { sha: BASE_SHA },
    head: { sha: HEAD_SHA },
    providers: {
      claude: provider === "claude" ? pass : absent,
      codex: provider === "codex" ? pass : absent,
    },
    turnBudgets: {
      claudeAuthorized: provider === "claude" ? 1 : 0,
      claudeSpent: provider === "claude" ? 1 : 0,
      codexAuthorized: provider === "codex" ? 2 : 0,
      codexSpent: provider === "codex" ? 2 : 0,
    },
    matrix: [],
    counters: zeroCounters(),
    deliveries: [{ messageHash: identityHash("delivery"), byteCount: 4 }],
    restart: { queuedRestored: 0, uncertainAfterRestart: 0, completedRestored: 0, reExecutions: 0 },
    cleanup: { storeRemoved: true, messageFilesRemoved: true, providerFilesUntouched: true },
  };
}
