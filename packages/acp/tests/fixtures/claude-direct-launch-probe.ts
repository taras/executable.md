/**
 * Issue #519 direct-launch probes — the boundaries Markdown cannot observe.
 *
 * `ClaudeDirectLaunch.test.md` owns sequencing, gating, parsing, assertions and
 * the operator-readable result. This fixture owns only what an authored
 * document cannot reach: ACP wire behavior, child argv/stdin/exit observation,
 * restrictive file setup, and exact-path cleanup.
 *
 * Every observation comes from a process outcome, an ACP protocol result, or a
 * value this fixture supplied. Nothing reads anything beneath `~/.claude`: the
 * question is whether Claude continues its own history, and reading Claude's
 * private files to answer it would prove something else entirely.
 *
 * `CLAUDE_CONFIG_DIR` is deliberately left alone. Relocating it de-authenticates
 * Claude Code 2.1.235 on this host, so the probe runs against the operator's
 * normal configuration and isolates by project path instead: one fresh `work`
 * directory per probe, purged afterwards through Claude's own path-scoped
 * `project purge`.
 *
 * One JSON object reaches stdout per mode. Diagnostics go to stderr, and
 * neither ever carries credentials, instruction text, the continuity marker, or
 * transcript content — `markerRecovered` is the only thing that crosses.
 */

import { each, ensure, main, race, scoped, sleep, stream, until, withResolvers } from "effection";
import type { Operation } from "effection";
import { ensureDir, exists, rm, writeTextFile } from "@effectionx/fs";
import { spawn as spawnChild } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import process from "node:process";
import { createAcpRuntime, createAgentRegistry, createRuntimeStore } from "acpx/runtime";
import type { AcpRuntimeTurn } from "acpx/runtime";

/** The frozen compatibility point these probes are only meaningful against. */
const VERSIONS = {
  claude: "2.1.235 (Claude Code)",
  acpx: "0.12.0",
  adapter: "@agentclientprotocol/claude-agent-acp@0.70.0",
} as const;

const ADAPTER_COMMAND = "npx -y @agentclientprotocol/claude-agent-acp@0.70.0";

/**
 * The instruction layer under test. Fixed text, so the outcome cannot depend on
 * what it says — only on where it travelled and whether it governed the turn.
 */
const INSTRUCTIONS = [
  "You are participating in an XMD session-continuity probe.",
  "Do not use tools.",
  "Follow requests for exact short replies.",
  "",
].join("\n");

const NATIVE_ACK = "NATIVE-TURN-RECORDED";

/** Both sides of the handoff must be this exact build, or the probe refuses. */
const REQUIRED_CLAUDE_VERSION = "2.1.235 (Claude Code)";

/** Each provider step is bounded well inside the document's block timeout. */
const NATIVE_SETTLE_MS = 300_000;
const ENSURE_MS = 300_000;
const ACP_TURN_MS = 300_000;
const PURGE_MS = 60_000;

type Verdict = "PASS" | "ENVIRONMENT_BLOCKED" | "GATE_1_FAILED" | "HARNESS_FAILED";

type ZeroTurnVerdict = "PASS" | "ENVIRONMENT_BLOCKED" | "GATE_2_UNRESOLVED" | "HARNESS_FAILED";

/** The only conversation-channel byte this probe is permitted to send. */
const EOF_BYTE = "\u0004";

/**
 * The minimum affirmative answer Claude's workspace-trust dialog requires.
 *
 * Terminal control input, recorded on its own channel: it acknowledges a
 * directory, creates no user turn and reaches no model. It is never sent once a
 * conversation surface has appeared, and never more than once per process.
 */
const TRUST_ANSWER = "y\n";
const TRUST_ANSWER_BYTES = "790a";

/**
 * Claude answers a first Ctrl-D at the conversation prompt with this, rather
 * than exiting. It is the surface's own affordance, and the only thing this
 * probe accepts as proof the conversation prompt received the EOF.
 */
const CTRL_D_AFFORDANCE = "Press Ctrl-D again to exit";

/** Two Ctrl-D bytes: one to probe readiness, one to exit. */
const EXIT_CONTROL_BYTES = "0404";

/** How long a process with no trust dialog is given before the readiness probe. */
const READINESS_PROBE_DELAY_MS = 4_000;

/** Each PTY phase is bounded on its own. */
const PTY_PHASE_MS = 30_000;

/**
 * What a purge established about the project directory.
 *
 * `nothing-to-purge` is a clean outcome, not a failure: `claude project purge`
 * exits nonzero when it finds no state for a path, and a probe that stopped
 * before Claude ever recorded the project has left nothing behind — which is
 * exactly what cleanup is asserting. Only an unrecognized failure is a failure.
 */
type PurgeOutcome = "purged" | "nothing-to-purge" | "failed";

interface Cleanup {
  instructionFileRemoved: boolean;
  acpxStateRemoved: boolean;
  projectPurgeDryRunExitCode: number;
  projectPurgeExitCode: number | null;
  projectPurgeOutcome: PurgeOutcome;
  temporaryRootRemoved: boolean;
  liveChildren: number;
}

class ProbeTimeout extends Error {
  override name = "ProbeTimeout";
  constructor(readonly phase: string) {
    super(`probe phase "${phase}" exceeded its bound`);
  }
}

/** Run `op` under a bound. The loser is halted with the surrounding scope. */
function* bounded<T>(phase: string, ms: number, op: () => Operation<T>): Operation<T> {
  const outcome = yield* race([
    (function* (): Operation<{ done: true; value: T }> {
      return { done: true, value: yield* op() };
    })(),
    (function* (): Operation<{ done: false }> {
      yield* sleep(ms);
      return { done: false };
    })(),
  ]);
  if (!outcome.done) {
    throw new ProbeTimeout(phase);
  }
  return outcome.value;
}

interface ChildOutcome {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
}

/**
 * Run one child to settlement, feeding `input` on stdin.
 *
 * stdin, never argv or environment: the user turn is conversation content, and
 * a process's arguments are readable by anything else on the machine.
 */
function runChild(
  command: string,
  args: string[],
  options: { cwd: string; input?: string; live: Set<number>; sink?: { text: string } },
): Operation<ChildOutcome> {
  return (function* (): Operation<ChildOutcome> {
    const settled = withResolvers<ChildOutcome>();
    const failed = withResolvers<never>();
    let child: ChildProcess | undefined;

    // Registered before the spawn: a halt between acquiring a process and
    // registering its cleanup leaks the process.
    yield* ensure(() => {
      const running = child;
      if (!running?.pid) {
        return;
      }
      if (running.exitCode === null && running.signalCode === null) {
        try {
          process.kill(running.pid, "SIGKILL");
        } catch {
          // Already gone, which is the state this was asking for.
        }
      }
      options.live.delete(running.pid);
    });

    child = spawnChild(command, args, { cwd: options.cwd, stdio: ["pipe", "pipe", "pipe"] });
    if (child.pid) {
      options.live.add(child.pid);
    }
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      if (options.sink) {
        options.sink.text += chunk.toString();
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      if (options.sink) {
        options.sink.text += chunk.toString();
      }
    });
    child.once("error", (error: Error) => failed.reject(error));
    child.once("close", (code: number | null, signal: string | null) => {
      if (child?.pid) {
        options.live.delete(child.pid);
      }
      settled.resolve({ code, signal, stdout, stderr });
    });

    if (options.input !== undefined) {
      child.stdin?.write(options.input);
    }
    child.stdin?.end();

    return yield* race([settled.operation, failed.operation]);
  })();
}

/** One invocation's owned paths, every one an exact absolute path. */
interface Invocation {
  root: string;
  /** Canonical, because Claude keys a project by its resolved path. */
  work: string;
  acpxState: string;
  instructionFile: string;
  live: Set<number>;
  cleanup: Cleanup;
}

/**
 * Create the invocation root and canonicalize the project directory.
 *
 * `CLAUDE_CONFIG_DIR` is left exactly as the operator has it. Isolation here is
 * by project path: a directory nothing else has ever used, purged afterwards
 * through Claude's own path-scoped command.
 */
function* useInvocation(label: string): Operation<Invocation> {
  const root = join(tmpdir(), `xmd-519-${label}-${randomUUID()}`);
  yield* until(mkdir(root, { recursive: true, mode: 0o700 }));
  yield* until(chmod(root, 0o700));

  const work = join(root, "work");
  yield* ensureDir(work);
  const acpxState = join(root, "acpx");
  yield* ensureDir(acpxState);

  const invocation: Invocation = {
    root,
    // Claude records a project under its resolved path, and on macOS the
    // temporary root reaches it through a symlink. Purging the unresolved
    // spelling would name a project that does not exist.
    work: yield* until(realpath(work)),
    acpxState,
    instructionFile: join(root, "instructions.txt"),
    live: new Set<number>(),
    cleanup: {
      instructionFileRemoved: false,
      acpxStateRemoved: false,
      projectPurgeDryRunExitCode: -1,
      projectPurgeExitCode: null,
      projectPurgeOutcome: "failed",
      temporaryRootRemoved: false,
      liveChildren: 0,
    },
  };

  // Registered before any child exists. Only the exact absolute paths this
  // invocation created are ever removed — never a wildcard or prefix.
  yield* ensure(function* () {
    for (const pid of invocation.live) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
    invocation.cleanup.liveChildren = [...invocation.live].filter(isReachable).length;

    yield* rm(invocation.instructionFile, { recursive: false, force: true });
    invocation.cleanup.instructionFileRemoved = !(yield* exists(invocation.instructionFile));
    yield* rm(invocation.acpxState, { recursive: true, force: true });
    invocation.cleanup.acpxStateRemoved = !(yield* exists(invocation.acpxState));

    // Claude's own path-scoped purge, never manual deletion of provider state.
    // The dry run is a permission to proceed, and its raw output is not kept.
    const dryRun = yield* bounded("project-purge-dry-run", PURGE_MS, () =>
      runChild("claude", ["project", "purge", "--dry-run", invocation.work], {
        cwd: root,
        live: invocation.live,
      }),
    );
    invocation.cleanup.projectPurgeDryRunExitCode = dryRun.code ?? -1;
    if (dryRun.code === 0) {
      const purge = yield* bounded("project-purge", PURGE_MS, () =>
        runChild("claude", ["project", "purge", "--yes", invocation.work], {
          cwd: root,
          live: invocation.live,
        }),
      );
      invocation.cleanup.projectPurgeExitCode = purge.code;
      invocation.cleanup.projectPurgeOutcome = purge.code === 0 ? "purged" : "failed";
    } else if (noProjectState(dryRun)) {
      invocation.cleanup.projectPurgeOutcome = "nothing-to-purge";
    } else {
      invocation.cleanup.projectPurgeOutcome = "failed";
    }

    yield* rm(invocation.root, { recursive: true, force: true });
    invocation.cleanup.temporaryRootRemoved = !(yield* exists(invocation.root));
  });

  return invocation;
}

function isReachable(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

interface NativeToAcpResult {
  probe: "native-to-acp";
  /** The absolute executable both sides of the handoff are bound to. */
  claudeExecutable: string;
  /** `--version` of the executable that creates the native session. */
  nativeClaudeVersion: string;
  /** What the ACP adapter was pinned to through `CLAUDE_CODE_EXECUTABLE`. */
  adapterClaudeExecutable: string;
  /** `--version` of the executable the adapter is pinned to. */
  adapterClaudeVersion: string;
  /** Whether both sides resolved to the same absolute path and version. */
  executableAligned: boolean;
  verdict: Verdict;
  versions: typeof VERSIONS;
  identitySource: "client-allocated";
  nativeSessionId: string;
  resumeSessionId: string;
  nativeTurnCount: number;
  acpTurnCount: number;
  nativeAcknowledged: boolean;
  acpTurnCompleted: boolean;
  markerRecovered: boolean;
  substitutedIdentity: boolean;
  claudeConfigDirOverridden: boolean;
  privateStateInspected: false;
  preparedTextInArgv: boolean;
  preparedTextInEnvironment: boolean;
  cleanup: Cleanup;
  detail: string;
}

/**
 * The probe, reported only after its invocation scope has been dismantled.
 *
 * The cleanup counters are filled in by teardown, so a result serialized while
 * the scope was still open would report every one of them false and claim the
 * probe leaked what it had not yet released.
 */
function* probeNativeToAcp(): Operation<NativeToAcpResult> {
  const result = blankResult();
  yield* scoped(function* () {
    yield* runNativeToAcp(result);
  });
  return result;
}

function* runNativeToAcp(result: NativeToAcpResult): Operation<void> {
  const invocation = yield* useInvocation("native-to-acp");
  result.cleanup = invocation.cleanup;

  // XMD allocates the identity. Its provenance is client-allocated: nothing
  // here parses, copies or translates an ACP, ACPX or backend value into it.
  const allocated = randomUUID();
  // Lives only in the native user turn. Absent from the instruction file, the
  // ACP prompt, argv, the environment and the session key — which is what makes
  // recovering it evidence of continued history rather than of an agreeable
  // model.
  const marker = `MK-${randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase()}`;
  result.nativeSessionId = allocated;
  result.resumeSessionId = allocated;

  // One executable for both sides of the handoff, resolved before anything
  // provider-facing starts. Native launch runs it directly; the ACP adapter is
  // pinned to the same absolute path through the variable its own
  // `claudeCliPath()` consults first.
  const executable = yield* resolveClaudeExecutable(invocation.root, invocation.live);
  if (executable.length === 0) {
    result.verdict = "ENVIRONMENT_BLOCKED";
    result.detail = "no installed claude executable found on PATH";
    return;
  }
  result.claudeExecutable = executable;
  result.adapterClaudeExecutable = executable;
  process.env.CLAUDE_CODE_EXECUTABLE = executable;

  result.nativeClaudeVersion = yield* claudeVersion(executable, invocation.root, invocation.live);
  // Same path, so this is the version the adapter will run. Observed through
  // the same channel rather than assumed, so a divergence would still show.
  result.adapterClaudeVersion = yield* claudeVersion(
    process.env.CLAUDE_CODE_EXECUTABLE,
    invocation.root,
    invocation.live,
  );
  result.executableAligned =
    result.nativeClaudeVersion === REQUIRED_CLAUDE_VERSION &&
    result.adapterClaudeVersion === REQUIRED_CLAUDE_VERSION &&
    result.claudeExecutable === result.adapterClaudeExecutable;
  if (!result.executableAligned) {
    result.verdict = "ENVIRONMENT_BLOCKED";
    result.detail =
      `both sides must be ${REQUIRED_CLAUDE_VERSION}; observed native ` +
      `"${result.nativeClaudeVersion}" and adapter "${result.adapterClaudeVersion}"`;
    return;
  }

  yield* writeTextFile(invocation.instructionFile, INSTRUCTIONS);
  yield* until(chmod(invocation.instructionFile, 0o600));

  const nativeArgs = [
    "--safe-mode",
    "--tools",
    "",
    "--permission-mode",
    "dontAsk",
    "--session-id",
    allocated,
    "--system-prompt-file",
    invocation.instructionFile,
    "--print",
  ];

  // The prepared text travels by file. These record that it reached neither of
  // the two surfaces another process could read it from.
  result.preparedTextInArgv = nativeArgs.some((argument) => argument.includes(INSTRUCTIONS.trim()));
  result.preparedTextInEnvironment = Object.values(process.env).some(
    (value) => typeof value === "string" && value.includes(INSTRUCTIONS.trim()),
  );

  const native = yield* bounded("native-turn", NATIVE_SETTLE_MS, () =>
    runChild(executable, nativeArgs, {
      cwd: invocation.work,
      input: [
        `Remember this one-time marker for the next turn: ${marker}.`,
        `Reply exactly ${NATIVE_ACK}.`,
        "",
      ].join("\n"),
      live: invocation.live,
    }),
  );

  // Only a child that completed spent a turn. A refusal before the model — an
  // unauthenticated account, a rejected flag — costs nothing, and counting it
  // would misreport what the probe charged the operator for.
  result.nativeTurnCount = native.code === 0 ? 1 : 0;
  if (native.code !== 0) {
    result.verdict = "ENVIRONMENT_BLOCKED";
    result.detail = unauthenticated(native)
      ? "native claude reports no authenticated account; no model turn was spent"
      : `native claude exited ${native.code ?? "signal"} before acknowledging`;
    return;
  }
  result.nativeAcknowledged = native.stdout.includes(NATIVE_ACK);
  if (!result.nativeAcknowledged) {
    result.verdict = "ENVIRONMENT_BLOCKED";
    result.detail = "native turn completed without the expected acknowledgement";
    return;
  }

  // The instruction file belonged to that native invocation. Removing it before
  // reattachment is what makes the ACP turn evidence about the session's own
  // retained layer rather than about a file being re-read.
  yield* rm(invocation.instructionFile, { recursive: false, force: true });
  if (yield* exists(invocation.instructionFile)) {
    result.verdict = "HARNESS_FAILED";
    result.detail = "instruction file survived removal";
    return;
  }

  const runtime = createAcpRuntime({
    cwd: invocation.work,
    sessionStore: createRuntimeStore({ stateDir: invocation.acpxState }),
    agentRegistry: createAgentRegistry({ overrides: { claude: ADAPTER_COMMAND } }),
    permissionMode: "deny-all",
    nonInteractivePermissions: "deny",
  });

  let handle;
  try {
    handle = yield* bounded("ensure-session", ENSURE_MS, () =>
      until(
        runtime.ensureSession({
          sessionKey: "issue-519-native-to-acp",
          agent: "claude",
          mode: "persistent",
          cwd: invocation.work,
          resumeSessionId: allocated,
        }),
      ),
    );
  } catch (error) {
    result.verdict = "GATE_1_FAILED";
    result.detail = `ACPX could not load the supplied identity: ${classify(error)}`;
    return;
  }

  // Registered as soon as the handle exists, rather than in a `finally`:
  // cleanup that suspends there is not guaranteed to run when the operation is
  // halted, and this probe's whole point is that it leaves nothing behind.
  yield* ensure(function* () {
    try {
      // Not discarding persistent state: the native session is what the
      // operator would keep.
      yield* until(runtime.close({ handle, reason: "issue-519 probe complete" }));
    } catch {
      // Teardown trouble is reported through the cleanup counters.
    }
  });

  // Absence is not substitution; a different identity is.
  result.substitutedIdentity =
    handle.agentSessionId !== undefined && handle.agentSessionId !== allocated;
  if (result.substitutedIdentity) {
    result.verdict = "GATE_1_FAILED";
    result.detail = "ACPX reported a native identity other than the supplied one";
    return;
  }

  try {
    const turn = runtime.startTurn({
      handle,
      text: "Reply with only the one-time marker from the preceding user turn.",
      mode: "prompt",
      requestId: randomUUID(),
    });
    const answer = yield* bounded("acp-turn", ACP_TURN_MS, () => collectTurn(turn));
    result.acpTurnCount = 1;
    result.acpTurnCompleted = answer.completed;
    result.markerRecovered = answer.text.trim() === marker;
    if (!answer.completed) {
      result.verdict = "ENVIRONMENT_BLOCKED";
      result.detail = `ACP turn did not complete: ${answer.detail}`;
      return;
    }
  } catch (error) {
    result.verdict = "ENVIRONMENT_BLOCKED";
    result.detail = `ACP turn failed before an observation: ${classify(error)}`;
    return;
  }

  if (!result.markerRecovered) {
    result.verdict = "GATE_1_FAILED";
    result.detail = "ACP continuation did not recover the native turn's marker";
    return;
  }

  result.verdict = "PASS";
  result.detail = "native-created history continued through ACPX under the supplied identity";
}

function blankResult(): NativeToAcpResult {
  return {
    probe: "native-to-acp",
    claudeExecutable: "",
    nativeClaudeVersion: "",
    adapterClaudeExecutable: "",
    adapterClaudeVersion: "",
    executableAligned: false,
    verdict: "HARNESS_FAILED",
    versions: VERSIONS,
    identitySource: "client-allocated",
    nativeSessionId: "",
    resumeSessionId: "",
    nativeTurnCount: 0,
    acpTurnCount: 0,
    nativeAcknowledged: false,
    acpTurnCompleted: false,
    markerRecovered: false,
    substitutedIdentity: false,
    claudeConfigDirOverridden: process.env.CLAUDE_CONFIG_DIR !== undefined,
    privateStateInspected: false,
    preparedTextInArgv: false,
    preparedTextInEnvironment: false,
    cleanup: {
      instructionFileRemoved: false,
      acpxStateRemoved: false,
      projectPurgeDryRunExitCode: -1,
      projectPurgeExitCode: null,
      projectPurgeOutcome: "failed",
      temporaryRootRemoved: false,
      liveChildren: 0,
    },
    detail: "probe did not reach a verdict",
  };
}

interface ZeroTurnResult {
  probe: "zero-turn-exit";
  verdict: ZeroTurnVerdict;
  versions: typeof VERSIONS;
  claudeExecutable: string;
  nativeClaudeVersion: string;
  adapterClaudeExecutable: string;
  adapterClaudeVersion: string;
  executableAligned: boolean;
  identitySource: "client-allocated";
  nativeSessionId: string;
  /**
   * The conversation channel, which stays empty for the whole probe. Trust and
   * exit control are terminal control, recorded on their own channels below.
   */
  conversationInputBytes: string;
  trustInputBytes: string;
  initialExitControlBytes: string;
  reentryTrustInputBytes: string;
  reentryExitControlBytes: string;
  initialTrustAnswered: boolean;
  reentryTrustAnswered: boolean;
  modelTurnCount: number;
  outcome: "same-identity" | "no-session" | "unresolved";
  substitutedIdentity: boolean;
  privateStateInspected: false;
  cleanup: Cleanup;
  detail: string;
}

/** What a PTY surface turned out to be, without reading any provider state. */
type Surface = "conversation-ready" | "workspace-trust" | "no-session" | "unknown";

/**
 * Classify what the terminal is showing from its own output.
 *
 * Only the child's terminal output is read — never a transcript, never a file
 * beneath Claude's configuration. Each marker is Claude's own wording.
 */
function classifySurface(output: string): Surface {
  if (output.includes("No conversation found with session ID")) {
    return "no-session";
  }
  // Claude's own affordance at the input prompt: the first Ctrl-D is answered
  // with this rather than an exit, which is itself proof the conversation
  // surface received it.
  if (output.includes("Press Ctrl-D again to exit") || output.includes("? for shortcuts")) {
    return "conversation-ready";
  }
  // The workspace-trust dialog is a directory confirmation, not a conversation
  // surface, and EOF does not dismiss it. Recognizing it is what keeps this
  // probe from mistaking "blocked before the conversation" for "ready".
  if (output.includes("Permission Required: Accessing workspace") || output.includes("Enter y/n")) {
    return "workspace-trust";
  }
  return "unknown";
}

/** What one PTY-hosted Claude process did, and what the harness sent it. */
interface PtyOutcome {
  surface: Surface;
  settled: boolean;
  trustAnswered: boolean;
  repeatedTrust: boolean;
  /** Ctrl-D bytes actually written: "", "04", or "0404". */
  exitControlBytes: string;
  /** Whether the first Ctrl-D drew Claude's exact again-to-exit affordance. */
  affordanceSeen: boolean;
}

/**
 * Drive one PTY-hosted Claude through its surfaces, sending only control input.
 *
 * `/usr/bin/script` is the PTY boundary, so no PTY package is added. The
 * sequence is fixed and each step is conditioned on what the terminal showed:
 *
 * 1. if the exact workspace-trust dialog appears, answer it once — a directory
 *    acknowledgement that reaches no model;
 * 2. send one Ctrl-D as a readiness probe, because on this build the
 *    conversation surface announces itself only in response to one;
 * 3. accept only Claude's exact "Press Ctrl-D again to exit" as proof the
 *    conversation prompt received it; and
 * 4. send the second Ctrl-D that actually exits.
 *
 * The conversation channel is never written to at all. Everything above is
 * terminal control, reported on its own channels.
 */
function ptySession(
  executable: string,
  args: string[],
  options: { cwd: string; live: Set<number> },
): Operation<PtyOutcome> {
  return (function* (): Operation<PtyOutcome> {
    const settledOutcome = withResolvers<void>();
    const failed = withResolvers<never>();
    let child: ChildProcess | undefined;
    let text = "";
    // Each step reads only what arrived after the previous one was handled, so
    // a dialog already answered is never re-read as a fresh request and the
    // affordance is only ever matched against output the probe provoked.
    let consumed = 0;
    let trustAnswered = false;
    let repeatedTrust = false;
    let probeSent = false;
    let affordanceSeen = false;
    let exitSent = false;
    let probeTimer: ReturnType<typeof setTimeout> | undefined;

    yield* ensure(() => {
      clearTimeout(probeTimer);
      const running = child;
      if (!running?.pid) {
        return;
      }
      if (running.exitCode === null && running.signalCode === null) {
        try {
          process.kill(running.pid, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
      options.live.delete(running.pid);
    });

    const sendReadinessProbe = () => {
      if (probeSent) {
        return;
      }
      probeSent = true;
      consumed = text.length;
      child?.stdin?.write(EOF_BYTE);
    };

    child = spawnChild("/usr/bin/script", ["-q", "/dev/null", executable, ...args], {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (child.pid) {
      options.live.add(child.pid);
    }

    // A directory Claude already trusts shows no dialog, so the readiness probe
    // cannot wait on one. This fires only if nothing has probed by then.
    probeTimer = setTimeout(sendReadinessProbe, READINESS_PROBE_DELAY_MS);

    const react = (chunk: Buffer) => {
      text += chunk.toString();
      const fresh = text.slice(consumed);

      if (fresh.includes("No conversation found with session ID")) {
        consumed = text.length;
        return;
      }

      if (probeSent && !affordanceSeen && fresh.includes(CTRL_D_AFFORDANCE)) {
        affordanceSeen = true;
        consumed = text.length;
        if (!exitSent) {
          exitSent = true;
          child?.stdin?.write(EOF_BYTE);
        }
        return;
      }

      if (!probeSent && !trustAnswered && classifySurface(fresh) === "workspace-trust") {
        trustAnswered = true;
        consumed = text.length;
        child?.stdin?.write(TRUST_ANSWER);
        clearTimeout(probeTimer);
        // The dialog is answered; the readiness probe is what discovers whether
        // a conversation surface is now behind it.
        probeTimer = setTimeout(sendReadinessProbe, READINESS_PROBE_DELAY_MS);
        return;
      }

      if (probeSent && !affordanceSeen && classifySurface(fresh) === "workspace-trust") {
        repeatedTrust = true;
        consumed = text.length;
      }
    };

    child.stdout?.on("data", react);
    child.stderr?.on("data", react);
    child.once("error", (error: Error) => failed.reject(error));
    child.once("close", () => {
      if (child?.pid) {
        options.live.delete(child.pid);
      }
      settledOutcome.resolve();
    });

    let settled = true;
    try {
      yield* bounded("pty-phase", PTY_PHASE_MS, () =>
        race([settledOutcome.operation, failed.operation]),
      );
    } catch (error) {
      if (!(error instanceof ProbeTimeout)) {
        throw error;
      }
      settled = false;
    }

    const refused = text.includes("No conversation found with session ID");
    return {
      surface: refused
        ? "no-session"
        : affordanceSeen
          ? "conversation-ready"
          : classifySurface(text),
      settled,
      trustAnswered,
      repeatedTrust,
      exitControlBytes: exitSent ? EXIT_CONTROL_BYTES : probeSent ? "04" : "",
      affordanceSeen,
    };
  })();
}

/**
 * Probe 2 — is leaving a launched session without saying anything well defined?
 *
 * Launch interactively under an allocated identity, answer the workspace-trust
 * dialog if Claude asks whether it may work in this directory, then send
 * exactly one EOF at the conversation surface and nothing else. Re-enter with
 * `--resume` under the same identity and accept one of two answers: the session
 * comes back under the identity it was given, or Claude refuses that exact id.
 *
 * The trust answer is terminal control, not conversation: it acknowledges a
 * directory, reaches no model, and is reported on its own channel.
 */
function* probeZeroTurnExit(): Operation<ZeroTurnResult> {
  const result = blankZeroTurn();
  yield* scoped(function* () {
    yield* runZeroTurnExit(result);
  });
  return result;
}

function* runZeroTurnExit(result: ZeroTurnResult): Operation<void> {
  const invocation = yield* useInvocation("zero-turn-exit");
  result.cleanup = invocation.cleanup;

  const executable = yield* resolveClaudeExecutable(invocation.root, invocation.live);
  if (executable.length === 0) {
    result.verdict = "ENVIRONMENT_BLOCKED";
    result.detail = "no installed claude executable found on PATH";
    return;
  }
  result.claudeExecutable = executable;
  result.adapterClaudeExecutable = executable;
  process.env.CLAUDE_CODE_EXECUTABLE = executable;
  result.nativeClaudeVersion = yield* claudeVersion(executable, invocation.root, invocation.live);
  result.adapterClaudeVersion = yield* claudeVersion(
    process.env.CLAUDE_CODE_EXECUTABLE,
    invocation.root,
    invocation.live,
  );
  result.executableAligned =
    result.nativeClaudeVersion === REQUIRED_CLAUDE_VERSION &&
    result.adapterClaudeVersion === REQUIRED_CLAUDE_VERSION &&
    result.claudeExecutable === result.adapterClaudeExecutable;
  if (!result.executableAligned) {
    result.verdict = "ENVIRONMENT_BLOCKED";
    result.detail =
      `both sides must be ${REQUIRED_CLAUDE_VERSION}; observed native ` +
      `"${result.nativeClaudeVersion}" and adapter "${result.adapterClaudeVersion}"`;
    return;
  }

  const allocated = randomUUID();
  result.nativeSessionId = allocated;

  yield* writeTextFile(invocation.instructionFile, INSTRUCTIONS);
  yield* until(chmod(invocation.instructionFile, 0o600));

  const shared = [
    "--safe-mode",
    "--ax-screen-reader",
    "--tools",
    "",
    "--dangerously-skip-permissions",
  ];

  const initial = yield* ptySession(
    executable,
    [...shared, "--session-id", allocated, "--system-prompt-file", invocation.instructionFile],
    { cwd: invocation.work, live: invocation.live },
  );
  result.initialTrustAnswered = initial.trustAnswered;
  if (initial.trustAnswered) {
    result.trustInputBytes = TRUST_ANSWER_BYTES;
  }
  result.initialExitControlBytes = initial.exitControlBytes;

  if (initial.repeatedTrust) {
    result.verdict = "GATE_2_UNRESOLVED";
    result.detail = "the initial process asked for trust more than once";
    return;
  }
  if (!initial.affordanceSeen) {
    // The readiness probe drew no answer this probe recognizes, so the surface
    // it must exercise was never reached. That is the harness failing to drive
    // Claude, not Claude behaving badly.
    result.verdict = "HARNESS_FAILED";
    result.detail =
      `the first Ctrl-D did not draw "${CTRL_D_AFFORDANCE}" on initial launch ` +
      `(surface ${initial.surface}); trust was answered ` +
      `${initial.trustAnswered ? "once" : "never"}`;
    return;
  }
  if (initial.surface !== "conversation-ready") {
    // Not a statement about Claude. The harness could not observe the surface
    // it was told to drive, which the governing handoff classifies as a harness
    // failure precisely so it is never mistaken for a product property.
    result.verdict = "HARNESS_FAILED";
    result.detail =
      `initial launch never reached a recognizable conversation surface ` +
      `(${initial.surface}); trust was answered ${initial.trustAnswered ? "once" : "never"}`;
    return;
  }
  if (!initial.settled) {
    result.verdict = "HARNESS_FAILED";
    result.detail = "the conversation surface did not exit after the second Ctrl-D";
    return;
  }

  yield* rm(invocation.instructionFile, { recursive: false, force: true });

  const reentry = yield* ptySession(executable, [...shared, "--resume", allocated], {
    cwd: invocation.work,
    live: invocation.live,
  });
  result.reentryTrustAnswered = reentry.trustAnswered;
  if (reentry.trustAnswered) {
    result.reentryTrustInputBytes = TRUST_ANSWER_BYTES;
  }
  result.reentryExitControlBytes = reentry.exitControlBytes;

  if (reentry.repeatedTrust) {
    result.verdict = "GATE_2_UNRESOLVED";
    result.detail = "re-entry asked for trust more than once";
    return;
  }
  if (reentry.surface === "no-session") {
    result.outcome = "no-session";
    result.verdict = "PASS";
    result.detail = "re-entry refused the exact supplied identity explicitly";
    return;
  }
  if (reentry.surface === "conversation-ready") {
    if (!reentry.settled) {
      result.verdict = "HARNESS_FAILED";
      result.detail = "re-entry did not exit after the second Ctrl-D";
      return;
    }
    result.outcome = "same-identity";
    result.verdict = "PASS";
    result.detail = "re-entry reached its conversation surface under the exact supplied identity";
    return;
  }

  result.verdict = "GATE_2_UNRESOLVED";
  result.detail = `re-entry was neither same-identity nor an explicit refusal (${reentry.surface})`;
}

function blankZeroTurn(): ZeroTurnResult {
  return {
    probe: "zero-turn-exit",
    verdict: "HARNESS_FAILED",
    versions: VERSIONS,
    claudeExecutable: "",
    nativeClaudeVersion: "",
    adapterClaudeExecutable: "",
    adapterClaudeVersion: "",
    executableAligned: false,
    identitySource: "client-allocated",
    nativeSessionId: "",
    conversationInputBytes: "",
    trustInputBytes: "",
    initialExitControlBytes: "",
    reentryTrustInputBytes: "",
    reentryExitControlBytes: "",
    initialTrustAnswered: false,
    reentryTrustAnswered: false,
    // No prompt is ever sent, on either entry.
    modelTurnCount: 0,
    outcome: "unresolved",
    substitutedIdentity: false,
    privateStateInspected: false,
    cleanup: {
      instructionFileRemoved: false,
      acpxStateRemoved: false,
      projectPurgeDryRunExitCode: -1,
      projectPurgeExitCode: null,
      projectPurgeOutcome: "failed",
      temporaryRootRemoved: false,
      liveChildren: 0,
    },
    detail: "probe did not reach a verdict",
  };
}

interface TurnAnswer {
  completed: boolean;
  text: string;
  detail: string;
}

/**
 * Consume one ACP turn's output text and terminal result.
 *
 * Output-stream deltas only: a thought delta is not the agent's answer, and
 * counting one would let the probe pass on text the model never said.
 */
function* collectTurn(turn: AcpRuntimeTurn): Operation<TurnAnswer> {
  let text = "";
  for (const event of yield* each(stream(turn.events))) {
    if (event.type === "text_delta" && (event.stream ?? "output") === "output") {
      text += event.text;
    }
    yield* each.next();
  }
  const outcome = yield* until(turn.result);
  return { completed: outcome.status === "completed", text, detail: outcome.status };
}

/**
 * The absolute path of the installed `claude`, canonicalized.
 *
 * The adapter otherwise resolves the native binary shipped with the Claude
 * Agent SDK it pins, which is a different build from the one on the operator's
 * PATH. Binding both sides of the handoff to one executable is the whole point
 * of this variant.
 */
function* resolveClaudeExecutable(root: string, live: Set<number>): Operation<string> {
  const located = yield* bounded("resolve-claude", 30_000, () =>
    runChild("/usr/bin/which", ["claude"], { cwd: root, live }),
  );
  const path = located.stdout.trim();
  if (located.code !== 0 || path.length === 0) {
    return "";
  }
  return yield* until(realpath(path));
}

/** `claude --version` for one exact executable. */
function* claudeVersion(executable: string, root: string, live: Set<number>): Operation<string> {
  const reported = yield* bounded("claude-version", 30_000, () =>
    runChild(executable, ["--version"], { cwd: root, live }),
  );
  return reported.code === 0 ? reported.stdout.trim() : "";
}

/**
 * Whether the purge found no project state for that exact path.
 *
 * Matched on Claude's own wording, which names no credential and no transcript
 * content. A probe that never got as far as recording a project reaches here.
 */
function noProjectState(outcome: ChildOutcome): boolean {
  return `${outcome.stdout}${outcome.stderr}`.includes("No Claude Code project state found");
}

/**
 * Whether the child refused for want of an authenticated account.
 *
 * Matched on Claude's own refusal wording, which names no credential. The
 * distinction matters because it is an environment condition reached before any
 * model turn, not a structural gate result.
 */
function unauthenticated(outcome: ChildOutcome): boolean {
  return `${outcome.stdout}${outcome.stderr}`.includes("Not logged in");
}

/** A fixed-category description carrying no credential or transcript content. */
function classify(error: unknown): string {
  if (error instanceof ProbeTimeout) {
    return `timeout in ${error.phase}`;
  }
  if (error instanceof Error) {
    return error.name;
  }
  return "unknown";
}

main(function* () {
  const mode = process.argv[2];

  // Thrown, not `process.exitCode`: this runs inside `main()`, which settles the
  // process on its own outcome, so a refusal that merely set the code and
  // returned would exit 0 and read as a probe that ran and found nothing.
  if (process.env.XMD_CLAUDE_DIRECT_PROOF !== "1") {
    throw new Error(
      "claude-direct-launch-probe: refusing before any provider process — set " +
        "XMD_CLAUDE_DIRECT_PROOF=1 to spend the authorized Claude model turns",
    );
  }

  // The amended handoff forbids relocating it, because doing so
  // de-authenticates this Claude release and made the first probe impossible.
  if (process.env.CLAUDE_CONFIG_DIR !== undefined) {
    throw new Error(
      "claude-direct-launch-probe: CLAUDE_CONFIG_DIR is set — unset it so Claude " +
        "uses its normal authenticated configuration",
    );
  }

  if (mode === "native-to-acp") {
    process.stdout.write(`${JSON.stringify(yield* probeNativeToAcp(), null, 2)}\n`);
    return;
  }
  if (mode === "zero-turn-exit") {
    process.stdout.write(`${JSON.stringify(yield* probeZeroTurnExit(), null, 2)}\n`);
    return;
  }

  throw new Error(`claude-direct-launch-probe: unknown mode "${mode}"`);
});
