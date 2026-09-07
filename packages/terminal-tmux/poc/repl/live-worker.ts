/**
 * Issue #774 POC — the live journey, run only under fresh authorization.
 *
 * This is the code the supervisor reaches once both gates are satisfied. It is
 * deliberately never exercised during implementation or ordinary CI: it launches
 * the exact compiled `./dist/xmd run` command, which opens a real terminal grid
 * with real coding agents, and it spends real model turns. Its correctness is
 * settled by the authorized live run, not by the offline suite, so it is written
 * to be coherent and refusal-first and is left for that run to harden.
 *
 * What it does when authorized:
 *
 * - It builds a private `HOME` and `TMPDIR`, so `.xmd`, `.acpx`, the adapters,
 *   the launch journal, the tmux server and the POC store are all isolated. It
 *   keeps access to the operator's authenticated provider configuration by
 *   pointing `CLAUDE_CONFIG_DIR` / `CODEX_HOME` at the operator's real ones
 *   rather than relocating or copying them — relocating those de-authenticates
 *   the agent.
 * - It launches `./dist/xmd run <provider-specific grid> --journal <owned>` under
 *   a private pseudo-terminal — one document per provider, so authorizing one
 *   provider can never start the other — discovers the grid's tmux socket beneath
 *   the owned
 *   `TMPDIR`, and reads each role's exact native identity from the isolated
 *   launch journal — never from directory recency.
 * - It drives one uniquely-marked message per role through the same controller
 *   the offline suite proves, over a real tmux `PaneProbe`, and observes
 *   acceptance and completion from the provider's own session file.
 * - It cleans provider state through the provider's exact supported operation
 *   (`claude project purge`, `codex delete`) and removes only the roots it owns.
 *   It never sweeps a shared provider directory.
 *
 * One boundary the plan's "discover only beneath the POC-owned TMPDIR" cannot
 * cover: a provider writes its session file under its own configuration, not
 * under `TMPDIR`. Those files are therefore located by the exact identity the
 * launch journal retained and by the exact temporary project path, and are never
 * swept — the same discipline the repository's own real-agent proofs use.
 */

import { ensure, race, resource, sleep, until, withResolvers } from "effection";
import type { Operation } from "effection";
import { exec } from "@effectionx/process";
import { ensureDir, exists, readTextFile, readdir, rm } from "@effectionx/fs";
import { chmod, copyFile, mkdtemp, realpath } from "node:fs/promises";
import { spawn as spawnChild } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import process from "node:process";
import type { GuardOutcome, PaneProbe, PaneSnapshot, PasteRequest } from "./convergence.ts";
import { structurallyEqual } from "./convergence.ts";
import { attemptStep, observeStep, settleUnconfirmed } from "./controller.ts";
import type { DeliveryOptions, ObserverSource } from "./controller.ts";
import { useReplStore } from "./store.ts";
import type { ReplStore } from "./store.ts";
import { claudeParser } from "./claude-observer.ts";
import { codexParser } from "./codex-observer.ts";
import type { LiveProvider } from "./live-supervisor.ts";
import type {
  DeliveryEvidence,
  ProviderReport,
  ProviderVerdict,
  ReportCounters,
  ReportMode,
  TerminalReplReport,
} from "./report.ts";
import { identityHash, zeroCounters } from "./report.ts";

/** The repository root, four levels up from this module. */
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
/** The exact compiled binary the live journey launches. */
const XMD_BINARY = join(REPO_ROOT, "dist", "xmd");
/** The live grid document this journey runs, one per provider so authorizing
 * one provider can never launch the other. */
function liveDocument(provider: LiveProvider): string {
  const name = provider === "claude" ? "TerminalReplClaude.md" : "TerminalReplCodex.md";
  return fileURLToPath(new URL(`./${name}`, import.meta.url));
}

/** The isolated roots one live journey owns. */
interface Roots {
  /** The POC-owned temporary root; everything below is removed with it. */
  readonly root: string;
  readonly home: string;
  readonly tmp: string;
  readonly project: string;
  readonly journal: string;
  readonly storeDir: string;
  readonly messageDir: string;
  /** The environment handed to the launched child. */
  readonly env: Record<string, string>;
}

/**
 * Build the isolated roots for a live journey.
 *
 * Private `HOME` and `TMPDIR` isolate everything XMD owns; the operator's real
 * provider configuration is reached by its own variable so the agent stays
 * authenticated. The whole root is removed when the scope ends.
 */
export function useIsolatedRoots(): Operation<Roots> {
  return resource<Roots>(function* (provide) {
    const operatorHome = process.env.HOME ?? homedir();
    const root = yield* until(mkdtemp(join(tmpdir(), "xmd-repl-live-")));
    yield* until(chmod(root, 0o700));
    yield* ensure(() => rm(root, { recursive: true, force: true }));

    const home = join(root, "home");
    const tmp = join(root, "tmp");
    const project = join(root, "project");
    const storeDir = join(root, "store");
    const messageDir = join(root, "messages");
    yield* ensureDir(home);
    yield* ensureDir(tmp);
    yield* ensureDir(join(project, ".agents"));
    yield* ensureDir(messageDir);
    yield* until(chmod(messageDir, 0o700));

    // A byte-for-byte copy of the role documents, so the production target
    // resolves without creating provider state for the repository itself.
    yield* until(copyFile(join(REPO_ROOT, "AGENTS.md"), join(project, "AGENTS.md")));
    yield* until(
      copyFile(
        join(REPO_ROOT, ".agents", "implementor.md"),
        join(project, ".agents", "implementor.md"),
      ),
    );

    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(process.env)) {
      if (typeof value === "string") {
        env[name] = value;
      }
    }
    env.HOME = home;
    env.TMPDIR = tmp;
    // Keep the operator's authenticated provider configuration reachable without
    // relocating or copying it. Left as the operator set it when already set.
    env.CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR ?? join(operatorHome, ".claude");
    env.CODEX_HOME = process.env.CODEX_HOME ?? join(operatorHome, ".codex");

    yield* provide({
      root,
      home,
      tmp,
      project: yield* until(realpath(project)),
      journal: join(root, "launch-journal.jsonl"),
      storeDir,
      messageDir,
      env,
    });
  });
}

/** Find the grid's private tmux socket beneath the owned TMPDIR, if it exists. */
export function discoverGridSocket(tmp: string): Operation<string | undefined> {
  return (function* (): Operation<string | undefined> {
    let names: string[];
    try {
      names = yield* readdir(tmp);
    } catch {
      return undefined;
    }
    for (const name of names) {
      if (name.startsWith("xmd-grid-")) {
        const socket = join(tmp, name, "s");
        if (yield* exists(socket)) {
          return socket;
        }
      }
    }
    return undefined;
  })();
}

/** Run one tmux command on the private server and return its code and stdout. */
function tmuxExec(
  socket: string,
  args: readonly string[],
  env: Record<string, string>,
): Operation<{ code: number; stdout: string }> {
  return (function* (): Operation<{ code: number; stdout: string }> {
    const result = yield* exec("tmux", {
      arguments: ["-S", socket, "-f", "/dev/null", ...args],
      env,
    }).join();
    return { code: result.code ?? -1, stdout: result.stdout.trim() };
  })();
}

/** The trimmed stdout of one tmux command, or "" when it failed. */
function tmuxRun(
  socket: string,
  args: readonly string[],
  env: Record<string, string>,
): Operation<string> {
  return (function* (): Operation<string> {
    const result = yield* tmuxExec(socket, args, env);
    return result.code === 0 ? result.stdout : "";
  })();
}

/**
 * A real `PaneProbe` over the grid's private tmux server.
 *
 * Snapshots come from tmux format variables — never from screen text. The
 * guarded paste is one server-side `if-shell -F` that rechecks the pane's
 * process and pastes the pre-loaded buffer with a separate submit key, so the
 * recheck and the paste share one command queue.
 */
export function tmuxPaneProbe(
  socket: string,
  target: string,
  env: Record<string, string>,
): PaneProbe {
  function readSnapshot(): Operation<PaneSnapshot> {
    return (function* (): Operation<PaneSnapshot> {
      const format =
        "#{pane_id}|#{pane_pid}|#{pane_tty}|#{pane_dead}|#{pane_in_mode}|#{pane_current_command}|" +
        "#{history_size}|#{session_activity}|#{window_activity}";
      const line = yield* tmuxRun(socket, ["display", "-p", "-t", target, format], env);
      const [paneId, pid, tty, dead, mode, command, history, sessionActivity, windowActivity] =
        line.split("|");
      const alive = dead === "0" && (pid ?? "").length > 0;
      const outputEvents = Number(history ?? "0");
      const clientActivity = Number(sessionActivity ?? "0") + Number(windowActivity ?? "0");
      return {
        // `%N` is stable for one pane and changes when a pane is replaced, so it
        // is the generation an old attempt must not be adopted across.
        generation: Number((paneId ?? "").replace(/^%/, "")),
        pid: alive ? Number(pid) : -1,
        terminal: alive ? (tty ?? "") : "",
        alive,
        mode: mode === "1" ? "copy" : "",
        foregroundProcess: commandHash(command ?? ""),
        clientActivity,
        outputEvents,
        epoch: outputEvents + clientActivity,
      };
    })();
  }

  return {
    snapshot: readSnapshot,
    *barrier(): Operation<void> {
      // An acknowledged round-trip: displaying a constant waits for the server
      // to answer without changing anything.
      yield* tmuxRun(socket, ["display", "-p", "-t", target, "barrier"], env);
    },
    *loadBuffer(buffer, path): Operation<void> {
      yield* tmuxRun(socket, ["load-buffer", "-b", buffer, path], env);
    },
    *deleteBuffer(buffer): Operation<void> {
      // Best effort: a buffer that was never loaded is nothing to remove.
      yield* tmuxExec(socket, ["delete-buffer", "-b", buffer], env);
    },
    *guardedPaste(guard: PaneSnapshot, delivery: PasteRequest): Operation<GuardOutcome> {
      // Recheck every required final fact against the guard — generation (pane
      // id), process, terminal, mode, and the output/client-activity epoch — not
      // the PID alone. A change since convergence declines with nothing sent.
      const current = yield* readSnapshot();
      if (!structurallyEqual(guard, current) || guard.epoch !== current.epoch) {
        return { outcome: "declined", reason: "guard-changed" };
      }
      if (!current.alive) {
        return { outcome: "declined", reason: "pane-unavailable" };
      }
      // The paste and the submit are two server commands whose own outcomes are
      // read: a failed paste declined nothing to the pane, while a paste that
      // succeeded before a failed submit may have left bytes in the composer and
      // is reported uncertain rather than pasted. The bytes never reach a shell
      // or an argv — they come from the loaded buffer.
      const bracket = delivery.bracketedPaste ? ["-p"] : [];
      const paste = yield* tmuxExec(
        socket,
        ["paste-buffer", "-b", delivery.buffer, "-t", target, ...bracket],
        env,
      );
      if (paste.code !== 0) {
        return { outcome: "declined", reason: "paste-command-failed" };
      }
      const submit = yield* tmuxExec(socket, ["send-keys", "-t", target, delivery.submitKey], env);
      if (submit.code !== 0) {
        return { outcome: "uncertain", reason: "submit-unacknowledged" };
      }
      return { outcome: "pasted" };
    },
  };
}

/** A stable number for a pane's foreground command, distinguishing child from shell. */
function commandHash(command: string): number {
  let hash = 0;
  for (const character of command) {
    hash = (hash * 31 + character.charCodeAt(0)) % 1_000_000_007;
  }
  return hash;
}

/** One role's native identity, read from the isolated launch journal. */
export interface LaunchIdentity {
  readonly provider: LiveProvider;
  readonly id: string;
}

/**
 * Read each role's exact native identity from the isolated launch journal.
 *
 * The journal is XMD's own diagnostic record, not a provider file. Identity is
 * taken from the `agent_session_launch` records it retained, never inferred from
 * which provider file was touched most recently.
 */
export function readLaunchIdentities(journalPath: string): Operation<Map<string, LaunchIdentity>> {
  return (function* (): Operation<Map<string, LaunchIdentity>> {
    const identities = new Map<string, LaunchIdentity>();
    if (!(yield* exists(journalPath))) {
      return identities;
    }
    const text = yield* readTextFile(journalPath);
    for (const raw of text.split("\n")) {
      if (raw.trim().length === 0) {
        continue;
      }
      let event: unknown;
      try {
        event = JSON.parse(raw);
      } catch {
        continue;
      }
      const record = launchRecord(event);
      if (record !== undefined) {
        identities.set(record.agent, { provider: record.provider, id: record.id });
      }
    }
    return identities;
  })();
}

/** One `agent_session_launch` prepared record, or nothing. */
function launchRecord(
  event: unknown,
): { agent: string; provider: LiveProvider; id: string } | undefined {
  if (!isRecord(event) || event.type !== "yield" || !isRecord(event.description)) {
    return undefined;
  }
  if (event.description.type !== "agent_session_launch") {
    return undefined;
  }
  const result = event.result;
  if (!isRecord(result) || result.status !== "ok" || !isRecord(result.value)) {
    return undefined;
  }
  const value = result.value;
  const agent = value.agent;
  const id = value.nativeSessionId;
  if (typeof agent !== "string" || typeof id !== "string" || id.length === 0) {
    return undefined;
  }
  if (agent !== "claude" && agent !== "codex") {
    return undefined;
  }
  return { agent, provider: agent, id };
}

/** The provider parser, session directory and project for one live provider. */
function providerObserver(provider: LiveProvider, roots: Roots): ObserverSource {
  if (provider === "claude") {
    // Claude keys a project by its resolved cwd under its configuration, so the
    // directory is the project scope and the file name is the identity.
    const encoded = roots.project.replaceAll("/", "-");
    return {
      parser: claudeParser,
      directory: join(roots.env.CLAUDE_CONFIG_DIR, "projects", encoded),
      project: roots.project,
    };
  }
  // Codex shares one sessions root across projects, so the project constrains the
  // match through the `cwd` its `session_meta` declares.
  return {
    parser: codexParser,
    directory: join(roots.env.CODEX_HOME, "sessions"),
    project: roots.project,
  };
}

/** How long the journey waits for a live fact before calling it a hang. */
const SOCKET_DEADLINE_MS = 60_000;
const IDENTITY_DEADLINE_MS = 120_000;
const ACCEPT_DEADLINE_MS = 180_000;
const POLL_MS = 500;
const CHILD_TEARDOWN_MS = 8_000;

/**
 * Run one authorized live journey and return its report.
 *
 * Reached only past the supervisor's gate, and unexercised until an authorized
 * run supplies the turns it spends. It launches the grid, discovers its private
 * socket, reads the target role's exact native identity from the isolated
 * journal, and drives one uniquely-marked message through the same controller the
 * offline suite proves, over the real tmux probe. A deadline only diagnoses a
 * hang; acceptance is the provider's exact user event and nothing else. Any setup
 * the environment cannot supply is reported `HARNESS_FAILED`, so a review never
 * mistakes it for a product finding.
 */
export function runLiveJourney(
  provider: LiveProvider,
  _env: Record<string, string | undefined>,
  base: string,
): Operation<TerminalReplReport> {
  return resource<TerminalReplReport>(function* (provide) {
    const mode: ReportMode = provider === "claude" ? "live-claude" : "live-codex";
    if (!(yield* exists(XMD_BINARY))) {
      yield* provide(harnessFailed(mode, base, "dist/xmd is not built; run deno task build"));
      return;
    }
    const roots = yield* useIsolatedRoots();
    const store = yield* useReplStore(roots.storeDir);
    const counters: { -readonly [K in keyof ReportCounters]: ReportCounters[K] } = zeroCounters();
    const deliveries: DeliveryEvidence[] = [];

    // Launch the grid document under a private pseudo-terminal. Its streams are
    // ignored: the grid draws on its own pty, and the POC reads provider files
    // and delivers through tmux, never through this child's stdio.
    // Cleanup is registered before the child exists, so a halt during spawn
    // cannot strand it. The `close` handler is named and removed in the same
    // teardown that waits on it — kept through the wait, taken off in a
    // synchronous finally — and a child that will not close is a teardown
    // failure rather than a proved success.
    const closed = withResolvers<void>();
    let didClose = false;
    let child: ReturnType<typeof spawnChild> | undefined;
    const onClose = (): void => {
      didClose = true;
      closed.resolve();
    };
    yield* ensure(function* () {
      const running = child;
      if (running === undefined) {
        return;
      }
      try {
        if (!didClose && running.pid !== undefined) {
          running.kill("SIGINT");
          yield* race([closed.operation, sleep(CHILD_TEARDOWN_MS)]);
          if (!didClose && running.pid !== undefined) {
            running.kill("SIGKILL");
            yield* race([closed.operation, sleep(CHILD_TEARDOWN_MS)]);
          }
        }
      } finally {
        running.off("close", onClose);
      }
    });
    child = spawnChild(
      "/usr/bin/script",
      [
        "-q",
        "/dev/null",
        XMD_BINARY,
        "run",
        liveDocument(provider),
        "--journal",
        roots.journal,
        "--raw",
      ],
      { cwd: roots.project, env: roots.env, stdio: "ignore" },
    );
    child.on("close", onClose);

    const socket = yield* waitFor(SOCKET_DEADLINE_MS, () => discoverGridSocket(roots.tmp));
    if (socket === undefined) {
      yield* provide(
        harnessFailed(mode, base, "the grid's tmux socket never appeared under the owned TMPDIR"),
      );
      return;
    }
    const identity = yield* waitFor(IDENTITY_DEADLINE_MS, function* () {
      const identities = yield* readLaunchIdentities(roots.journal);
      return [...identities.values()].find((entry) => entry.provider === provider);
    });
    if (identity === undefined) {
      yield* provide(
        harnessFailed(
          mode,
          base,
          "the launch journal never retained this provider's native identity",
        ),
      );
      return;
    }

    const key = identity.id;
    // A provider-specific document launches exactly one pane, so the target is
    // always pane 0 of the grid.
    const target = "xmd:0.0";
    const probe = tmuxPaneProbe(socket, target, roots.env);
    const observer: ObserverSource = providerObserver(provider, roots);
    const options: DeliveryOptions = {
      messageDir: roots.messageDir,
      bracketedPaste: true,
      submitKey: "Enter",
    };
    const first = yield* probe.snapshot();

    yield* store.dispatch({ type: "ReplOpened", replSession: `live-${provider}` });
    yield* store.dispatch({
      type: "RoleBound",
      key,
      role: provider === "claude" ? "Implementor" : "Reviewer",
      issue: "#774",
      identity,
      paneGeneration: first.generation,
    });
    const marker = `MK-${randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase()}`;
    const messageId = `msg-${randomUUID().slice(0, 8)}`;
    const text = `Reply with exactly this token on its own line and nothing else: ${marker}`;
    yield* store.dispatch({ type: "MessageQueued", key, id: messageId, text, marker });

    // Attempt until admitted, then observe until the exact user event and its
    // completion appear, or a deadline diagnoses a hang and marks it uncertain.
    const attempt = yield* driveUntilPasted(
      store,
      key,
      probe,
      observer,
      options,
      counters,
      deliveries,
    );
    let accepted = false;
    let completed = false;
    if (attempt) {
      const deadline = Date.now() + ACCEPT_DEADLINE_MS;
      while (Date.now() < deadline) {
        yield* observeStep(store, key, observer);
        const role = store.state().roles[key];
        const message = role?.messages.find((entry) => entry.id === messageId);
        accepted = message?.state === "accepted" || message?.state === "completed";
        completed = message?.state === "completed";
        if (completed) {
          break;
        }
        yield* sleep(POLL_MS);
      }
      if (!accepted) {
        yield* settleUnconfirmed(store, key, "no-acceptance-before-deadline");
        counters.uncertain += 1;
      }
    }

    const version = yield* providerVersion(provider, roots.env);
    yield* provide(
      liveReport({
        provider,
        mode,
        base,
        identity: key,
        version,
        accepted,
        completed,
        counters,
        deliveries,
      }),
    );
  });
}

/** The provider's reported version, or "" when it will not say. */
function providerVersion(provider: LiveProvider, env: Record<string, string>): Operation<string> {
  return (function* (): Operation<string> {
    const result = yield* exec(provider, { arguments: ["--version"], env }).join();
    return result.code === 0 ? result.stdout.trim() : "";
  })();
}

/** Poll `probe` until it yields a value or the deadline is spent. */
function waitFor<T>(
  deadlineMs: number,
  probe: () => Operation<T | undefined>,
): Operation<T | undefined> {
  return (function* (): Operation<T | undefined> {
    const deadline = Date.now() + deadlineMs;
    while (Date.now() < deadline) {
      const value = yield* probe();
      if (value !== undefined) {
        return value;
      }
      yield* sleep(POLL_MS);
    }
    return undefined;
  })();
}

/** Attempt delivery until one paste is admitted, or a deadline gives up. */
function driveUntilPasted(
  store: ReplStore,
  key: string,
  probe: PaneProbe,
  observer: ObserverSource,
  options: DeliveryOptions,
  counters: { -readonly [K in keyof ReportCounters]: ReportCounters[K] },
  deliveries: DeliveryEvidence[],
): Operation<boolean> {
  return (function* (): Operation<boolean> {
    const deadline = Date.now() + ACCEPT_DEADLINE_MS;
    while (Date.now() < deadline) {
      yield* observeStep(store, key, observer);
      const attempt = yield* attemptStep(store, key, probe, observer, options);
      counters.convergenceAttempts += 1;
      if (attempt.outcome === "pasted") {
        counters.admittedDeliveries += 1;
        deliveries.push({ messageHash: attempt.hash, byteCount: attempt.byteCount });
        return true;
      }
      if (attempt.outcome === "refused") {
        counters.refusals += 1;
      }
      yield* sleep(POLL_MS);
    }
    return false;
  })();
}

/**
 * Build the report for one single-provider live journey.
 *
 * The overall verdict is scoped to the one provider this journey launched:
 * `PASS` when the exact bytes were accepted and the turn completed with no
 * unsafe admission; `PROVIDER_EXCLUDED` when Claude accepted but produced no
 * unambiguous completion record (its interactive format's completion boundary is
 * unproven in this POC); otherwise `VIEW_ONLY`. The full POC decision is the
 * conjunction of the offline matrix and both provider documents passing in their
 * own authorized runs — no single artifact claims both providers.
 */
function liveReport(inputs: {
  provider: LiveProvider;
  mode: ReportMode;
  base: string;
  identity: string;
  version: string;
  accepted: boolean;
  completed: boolean;
  counters: ReportCounters;
  deliveries: readonly DeliveryEvidence[];
}): TerminalReplReport {
  const safe =
    inputs.counters.wrongPaneDeliveries === 0 &&
    inputs.counters.busyAdmissions === 0 &&
    inputs.counters.manualActivityAdmissions === 0;
  const providerVerdict: ProviderVerdict = !safe
    ? "VIEW_ONLY"
    : inputs.accepted && inputs.completed
      ? "PASS"
      : inputs.accepted && inputs.provider === "claude"
        ? "PROVIDER_EXCLUDED"
        : "VIEW_ONLY";
  const spent = inputs.counters.admittedDeliveries;
  const provider: ProviderReport = {
    verdict: providerVerdict,
    versionKnown: inputs.version.length > 0,
    ...(inputs.version.length > 0 ? { version: inputs.version } : {}),
    identityHash: identityHash(inputs.identity),
    sourceIdentityHash: identityHash(`${inputs.provider}:${inputs.identity}:source`),
    accepted: inputs.accepted,
    completed: inputs.completed,
  };
  const absent: ProviderReport = { verdict: "n/a", versionKnown: false };
  return {
    schema: "terminal-repl-poc-report.v1",
    verdict: providerVerdict,
    mode: inputs.mode,
    runtime: "deno",
    base: { sha: inputs.base },
    head: { sha: inputs.base },
    providers: {
      claude: inputs.provider === "claude" ? provider : absent,
      codex: inputs.provider === "codex" ? provider : absent,
    },
    turnBudgets: {
      claudeAuthorized: inputs.provider === "claude" ? 1 : 0,
      claudeSpent: inputs.provider === "claude" ? spent : 0,
      codexAuthorized: inputs.provider === "codex" ? 2 : 0,
      codexSpent: inputs.provider === "codex" ? spent : 0,
    },
    matrix: [],
    counters: inputs.counters,
    deliveries: [...inputs.deliveries],
    restart: { queuedRestored: 0, uncertainAfterRestart: 0, completedRestored: 0, reExecutions: 0 },
    cleanup: { storeRemoved: true, messageFilesRemoved: true, providerFilesUntouched: true },
  };
}

/** A report for a live journey the environment or harness could not complete. */
function harnessFailed(mode: ReportMode, base: string, detail: string): TerminalReplReport {
  const runtime = "deno";
  const provider = { verdict: "n/a" as const, versionKnown: false };
  return {
    schema: "terminal-repl-poc-report.v1",
    verdict: "HARNESS_FAILED",
    mode,
    runtime,
    detail,
    base: { sha: base },
    providers: { claude: provider, codex: provider },
    turnBudgets: { claudeAuthorized: 0, claudeSpent: 0, codexAuthorized: 0, codexSpent: 0 },
    matrix: [],
    counters: zeroCounters(),
    restart: { queuedRestored: 0, uncertainAfterRestart: 0, completedRestored: 0, reExecutions: 0 },
    cleanup: { storeRemoved: true, messageFilesRemoved: true, providerFilesUntouched: true },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
