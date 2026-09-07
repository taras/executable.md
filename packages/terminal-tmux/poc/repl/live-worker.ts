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

import { ensure, race, resource, scoped, sleep, spawn, until, withResolvers } from "effection";
import type { Operation } from "effection";
import { exec } from "@effectionx/process";
import { lines } from "@effectionx/stream-helpers";
import { ensureDir, exists, readTextFile, readdir, rm } from "@effectionx/fs";
import { chmod, copyFile, realpath } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { spawn as spawnChild } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import process from "node:process";
import type { GuardOutcome, PaneProbe, PaneSnapshot, PasteRequest } from "./convergence.ts";
import { attemptStep, observeStep, reconcileRestart, settleUnconfirmed } from "./controller.ts";
import type { DeliveryOptions, ObserverSource } from "./controller.ts";
import { useReplStore } from "./store.ts";
import type { ReplStore } from "./store.ts";
import { claudeParser } from "./claude-observer.ts";
import { locate } from "./observer.ts";
import { codexParser } from "./codex-observer.ts";
import type { LiveProvider } from "./live-supervisor.ts";
import type {
  CleanupEvidence,
  DeliveryEvidence,
  ProviderReport,
  ProviderVerdict,
  ReportCounters,
  ReportMode,
  ReportVerdict,
  RestartEvidence,
  TerminalReplReport,
} from "./report.ts";
import { countersSafe, decideProviderVerdict, identityHash, zeroCounters } from "./report.ts";

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
    // Created synchronously so nothing can suspend between naming the root and
    // registering its removal — an asynchronous create halted mid-flight would
    // leave a directory nothing owns.
    // oxlint-disable-next-line local/no-sync-filesystem
    const root = mkdtempSync(join(tmpdir(), "xmd-repl-live-"));
    yield* ensure(() => rm(root, { recursive: true, force: true }));
    yield* until(chmod(root, 0o700));

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

/**
 * One tmux command run against the private server, and its acknowledged result.
 *
 * The single seam the live pane probe is built on. The journey supplies the real
 * one (an `exec` of `tmux`); a test supplies a fake that returns canned command
 * outputs, so the probe's guard contract is exercised without a real server and
 * the fake and the live boundary enforce exactly the same contract.
 */
export type TmuxCommand = (args: readonly string[]) => Operation<{ code: number; stdout: string }>;

/**
 * The pane's real output and visible-client activity generations.
 *
 * Counted from the server's own control-mode events — `%output` and the
 * `%client-*` family — not from `history_size` or a timestamp. A change in either
 * generation between convergence and the final combined sample invalidates the
 * attempt.
 */
export interface PaneActivity {
  read(): Operation<{ outputEvents: number; clientActivity: number }>;
}

/**
 * A `PaneProbe` over an injectable tmux command seam and activity source.
 *
 * `guardedPaste` is one server-side `if-shell` conditional: it rechecks the pane
 * generation (`pane_id`), process, liveness and mode, then pastes the pre-loaded
 * buffer, sends the submit key, and prints an acknowledgement — or takes the
 * decline branch — in a single command with no suspension between the recheck and
 * the paste. Its outcome is read from the acknowledgement: the marker means
 * pasted, the decline marker means declined, a failed command or a missing
 * acknowledgement means uncertain — never pasted-as-proved. The message bytes
 * stay in the buffer and never enter the command string.
 */
export function paneProbeOver(run: TmuxCommand, target: string, activity: PaneActivity): PaneProbe {
  function readSnapshot(): Operation<PaneSnapshot> {
    return (function* (): Operation<PaneSnapshot> {
      const format =
        "#{pane_id}|#{pane_pid}|#{pane_tty}|#{pane_dead}|#{pane_in_mode}|#{pane_current_command}";
      const shown = yield* run(["display", "-p", "-t", target, format]);
      const [paneId, pid, tty, dead, mode, command] = (shown.code === 0 ? shown.stdout : "").split(
        "|",
      );
      const alive = dead === "0" && (pid ?? "").length > 0;
      const generations = yield* activity.read();
      return {
        // `%N` is stable for one pane and changes when a pane is replaced.
        generation: Number((paneId ?? "").replace(/^%/, "")),
        pid: alive ? Number(pid) : -1,
        terminal: alive ? (tty ?? "") : "",
        alive,
        mode: mode === "1" ? "copy" : "",
        foregroundProcess: commandHash(command ?? ""),
        clientActivity: generations.clientActivity,
        outputEvents: generations.outputEvents,
        epoch: generations.outputEvents + generations.clientActivity,
      };
    })();
  }

  return {
    snapshot: readSnapshot,
    *barrier(): Operation<void> {
      // An acknowledged round-trip that changes nothing by itself.
      yield* run(["display", "-p", "-t", target, "barrier"]);
    },
    *loadBuffer(buffer, path): Operation<void> {
      yield* run(["load-buffer", "-b", buffer, path]);
    },
    *deleteBuffer(buffer): Operation<void> {
      yield* run(["delete-buffer", "-b", buffer]);
    },
    *guardedPaste(guard: PaneSnapshot, delivery: PasteRequest): Operation<GuardOutcome> {
      const nonce = `XR${Math.random().toString(36).slice(2, 10)}`;
      const condition =
        `#{&&:#{==:#{pane_id},%${guard.generation}},` +
        `#{&&:#{==:#{pane_pid},${guard.pid}},` +
        `#{&&:#{==:#{pane_dead},0},#{==:#{pane_in_mode},0}}}}`;
      const bracket = delivery.bracketedPaste ? " -p" : "";
      const pasteAndSubmit =
        `paste-buffer -b ${delivery.buffer} -t ${target}${bracket} ; ` +
        `send-keys -t ${target} ${delivery.submitKey} ; display -p ${nonce}`;
      const result = yield* run([
        "if-shell",
        "-F",
        condition,
        pasteAndSubmit,
        "display -p DECLINED",
      ]);
      if (result.code !== 0) {
        return { outcome: "uncertain", reason: "guard-command-failed" };
      }
      if (result.stdout.includes(nonce)) {
        return { outcome: "pasted" };
      }
      if (result.stdout.includes("DECLINED")) {
        return { outcome: "declined", reason: "guard-rejected" };
      }
      // The command ran but acknowledged neither branch: the paste may or may not
      // have reached the pane, so the outcome is uncertain rather than pasted.
      return { outcome: "uncertain", reason: "submit-unacknowledged" };
    },
  };
}

/**
 * A live activity source backed by the server's control-mode event stream.
 *
 * It attaches one no-output control client and counts the `%output` and
 * `%client-*` events the server reports, so the probe reads real output and
 * visible-client generations rather than `history_size` or a timestamp. The
 * client is this scope's and is torn down with it.
 */
export function useControlFeed(
  socket: string,
  env: Record<string, string>,
): Operation<PaneActivity> {
  return resource<PaneActivity>(function* (provide) {
    let outputEvents = 0;
    let clientActivity = 0;
    yield* spawn(function* () {
      const client = yield* exec("tmux", {
        arguments: ["-S", socket, "-f", "/dev/null", "-C", "attach", "-f", "no-output"],
        env,
      });
      const reported = yield* lines()(client.stdout);
      let next = yield* reported.next();
      while (!next.done) {
        const line = next.value;
        if (line.startsWith("%output")) {
          outputEvents += 1;
        } else if (line.startsWith("%client-")) {
          clientActivity += 1;
        }
        next = yield* reported.next();
      }
    });
    yield* provide({
      // deno-lint-ignore require-yield
      *read(): Operation<{ outputEvents: number; clientActivity: number }> {
        return { outputEvents, clientActivity };
      },
    });
  });
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
  return (function* (): Operation<TerminalReplReport> {
    const mode: ReportMode = provider === "claude" ? "live-claude" : "live-codex";
    if (!(yield* exists(XMD_BINARY))) {
      return harnessFailed(mode, base, "dist/xmd is not built; run deno task build");
    }
    const head = yield* currentHead(base);

    // Evidence the journey fills in; cleanup is read only after the scope below
    // has torn down, so a cleanup field is never true before teardown settled.
    const counters: { -readonly [K in keyof ReportCounters]: ReportCounters[K] } = zeroCounters();
    const deliveries: DeliveryEvidence[] = [];
    const restart = {
      queuedRestored: 0,
      uncertainAfterRestart: 0,
      completedRestored: 0,
      reExecutions: 0,
    };
    const outcome = {
      ran: false,
      accepted: false,
      completed: false,
      identity: "",
      sourceHash: "",
      version: "",
      supportsCompletion: provider === "claude" ? claudeParser.supportsCompletion : true,
      materializationTurns: 0,
      nativeTurns: 0,
      harnessDetail: "",
    };
    let providerSessionRemoved = false;
    let rootPath = "";

    try {
      yield* scoped(function* (): Operation<void> {
        const roots = yield* useIsolatedRoots();
        rootPath = roots.root;
        const store = yield* useReplStore(roots.storeDir);

        const closed = withResolvers<void>();
        let didClose = false;
        let child: ReturnType<typeof spawnChild> | undefined;
        const onClose = (): void => {
          didClose = true;
          closed.resolve();
        };
        // Cleanup registered before the child exists; SIGKILL is followed by a
        // mandatory close proof — a child that will not close is a teardown
        // failure, never a proved success.
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
            if (!didClose) {
              throw new Error("the launched grid child could not be proved closed at teardown");
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
          outcome.harnessDetail = "the grid's tmux socket never appeared under the owned TMPDIR";
          return;
        }
        const identity = yield* waitFor(IDENTITY_DEADLINE_MS, function* () {
          const identities = yield* readLaunchIdentities(roots.journal);
          return [...identities.values()].find((entry) => entry.provider === provider);
        });
        if (identity === undefined) {
          outcome.harnessDetail =
            "the launch journal never retained this provider's native identity";
          return;
        }
        outcome.ran = true;
        outcome.identity = identity.id;

        // Clean the exact provider session through the provider's own supported
        // operation, and only that — never a direct transcript delete or a sweep.
        yield* ensure(function* () {
          const removal =
            provider === "claude"
              ? yield* runCommand("claude", ["project", "purge", "--yes", roots.project], roots.env)
              : yield* runCommand("codex", ["delete", "--force", identity.id], roots.env);
          providerSessionRemoved = removal;
        });

        const key = identity.id;
        const target = "xmd:0.0";
        const run: TmuxCommand = (args) => tmuxExec(socket, args, roots.env);
        const feed = yield* useControlFeed(socket, roots.env);
        const probe = paneProbeOver(run, target, feed);
        const observer: ObserverSource = providerObserver(provider, roots);
        outcome.supportsCompletion = observer.parser.supportsCompletion;
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

        const admitted = yield* driveUntilPasted(
          store,
          key,
          probe,
          observer,
          options,
          counters,
          deliveries,
        );
        if (admitted) {
          outcome.nativeTurns = 1;
          const deadline = Date.now() + ACCEPT_DEADLINE_MS;
          while (Date.now() < deadline) {
            yield* observeStep(store, key, observer);
            const role = store.state().roles[key];
            const message = role?.messages.find((entry) => entry.id === messageId);
            outcome.accepted = message?.state === "accepted" || message?.state === "completed";
            outcome.completed = message?.state === "completed";
            if (outcome.completed) {
              break;
            }
            yield* sleep(POLL_MS);
          }
          if (!outcome.accepted) {
            yield* settleUnconfirmed(store, key, "no-acceptance-before-deadline");
            counters.uncertain += 1;
          }
        }

        // The exact located source's file identity, hashed for the report.
        const located = yield* locate(observer.parser, observer.directory, key, observer.project);
        if (located.outcome === "located") {
          outcome.sourceHash = identityHash(located.source.fileKey);
        }
        // The materialization turn XMD spent, counted from the journal, not guessed.
        outcome.materializationTurns = yield* materializationTurns(roots.journal, key);
        outcome.version = yield* providerVersion(provider, roots.env);

        // A live restart proof: a fresh store over the same log must restore the
        // outcome and re-execute nothing.
        const restarted = yield* useReplStore(roots.storeDir);
        const settled = yield* reconcileRestart(restarted);
        restart.uncertainAfterRestart = settled;
        const restoredMessage = restarted
          .state()
          .roles[key]?.messages.find((m) => m.id === messageId);
        if (restoredMessage?.state === "completed") {
          restart.completedRestored = 1;
        } else if (restoredMessage?.state === "queued") {
          restart.queuedRestored = 1;
        }
        const replay = yield* attemptStep(restarted, key, probe, observer, options);
        if (replay.outcome === "pasted") {
          // Re-execution after restart is a defect the report must surface.
          restart.reExecutions = 1;
        }
      });
    } catch (error) {
      outcome.harnessDetail = classifyError(error);
    }

    // Read only now, after the scope's finalizers ran: the root is removed, its
    // message directory with it, and the provider session was cleaned.
    const rootGone = rootPath === "" ? true : !(yield* exists(rootPath));
    const cleanup: CleanupEvidence & { providerSessionRemoved: boolean } = {
      storeRemoved: rootGone,
      messageFilesRemoved: rootGone,
      providerFilesUntouched: true,
      providerSessionRemoved,
    };

    if (outcome.harnessDetail.length > 0 && !outcome.ran) {
      return harnessFailed(mode, base, outcome.harnessDetail);
    }
    return liveReport({
      provider,
      mode,
      base,
      head,
      identity: outcome.identity,
      sourceHash: outcome.sourceHash,
      version: outcome.version,
      accepted: outcome.accepted,
      completed: outcome.completed,
      supportsCompletion: outcome.supportsCompletion,
      materializationTurns: outcome.materializationTurns,
      nativeTurns: outcome.nativeTurns,
      counters,
      deliveries,
      restart,
      cleanup: {
        storeRemoved: cleanup.storeRemoved,
        messageFilesRemoved: cleanup.messageFilesRemoved,
        providerFilesUntouched: cleanup.providerFilesUntouched,
      },
    });
  })();
}

/** The current commit, for the report's head, or the base when git is unavailable. */
function currentHead(base: string): Operation<{ sha: string }> {
  return (function* (): Operation<{ sha: string }> {
    try {
      const result = yield* exec("git", { arguments: ["rev-parse", "HEAD"] }).join();
      const sha = result.stdout.trim();
      return { sha: result.code === 0 && /^[0-9a-f]{40}$/.test(sha) ? sha : base };
    } catch {
      return { sha: base };
    }
  })();
}

/** Run one provider cleanup command and report whether it succeeded. */
function runCommand(
  command: string,
  args: readonly string[],
  env: Record<string, string>,
): Operation<boolean> {
  return (function* (): Operation<boolean> {
    try {
      const result = yield* exec(command, { arguments: [...args], env }).join();
      return result.code === 0;
    } catch {
      return false;
    }
  })();
}

/** Count the materialization turns the launch journal retained for one session. */
function materializationTurns(journalPath: string, identity: string): Operation<number> {
  return (function* (): Operation<number> {
    if (!(yield* exists(journalPath))) {
      return 0;
    }
    const text = yield* readTextFile(journalPath);
    let count = 0;
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
      if (!isRecord(event) || !isRecord(event.result) || !isRecord(event.result.value)) {
        continue;
      }
      const value = event.result.value;
      if (value.phase === "materialized" && value.nativeSessionId === identity) {
        count += 1;
      }
    }
    return count;
  })();
}

/** A fixed-category description of a harness error, carrying no private detail. */
function classifyError(error: unknown): string {
  return error instanceof Error ? error.name : "unknown-harness-error";
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
  head: { sha: string };
  identity: string;
  sourceHash: string;
  version: string;
  accepted: boolean;
  completed: boolean;
  supportsCompletion: boolean;
  materializationTurns: number;
  nativeTurns: number;
  counters: ReportCounters;
  deliveries: readonly DeliveryEvidence[];
  restart: RestartEvidence;
  cleanup: CleanupEvidence;
}): TerminalReplReport {
  const safe = countersSafe(inputs.counters);
  const providerVerdict: ProviderVerdict = decideProviderVerdict({
    accepted: inputs.accepted,
    completed: inputs.completed,
    safe,
    supportsCompletion: inputs.supportsCompletion,
  });
  // Codex spends a materialization turn plus the marker turn; Claude spends only
  // the marker turn. Both are counted from evidence, never assumed.
  const spent =
    inputs.provider === "codex"
      ? inputs.materializationTurns + inputs.nativeTurns
      : inputs.nativeTurns;
  const provider: ProviderReport = {
    verdict: providerVerdict,
    versionKnown: inputs.version.length > 0,
    ...(inputs.version.length > 0 ? { version: inputs.version } : {}),
    identityHash: identityHash(inputs.identity),
    ...(inputs.sourceHash.length > 0 ? { sourceIdentityHash: inputs.sourceHash } : {}),
    accepted: inputs.accepted,
    completed: inputs.completed,
  };
  const absent: ProviderReport = { verdict: "n/a", versionKnown: false };
  // The single-provider journey's overall verdict is its provider verdict, which
  // is never "n/a" here (this provider ran).
  const overall: ReportVerdict = providerVerdict === "n/a" ? "VIEW_ONLY" : providerVerdict;
  return {
    schema: "terminal-repl-poc-report.v1",
    verdict: overall,
    mode: inputs.mode,
    runtime: "deno",
    base: { sha: inputs.base },
    head: inputs.head,
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
    restart: inputs.restart,
    cleanup: inputs.cleanup,
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
