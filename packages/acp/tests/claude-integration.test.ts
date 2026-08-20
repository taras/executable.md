/**
 * Tier CI — the opt-in Claude native-launch proof
 * (specs/native-agent-session-launch-spec.md §Provider-native identity).
 *
 * Knowing `claude --resume <id>` is not evidence that the session ACP created
 * is the session native Claude resumes, nor that the instruction layer XMD
 * installed is in force on its first user turn. Only the installed CLI can
 * settle that, and settling it costs a real model turn against the operator's
 * own credentials — so this does not run by default.
 *
 * Set `XMD_CLAUDE_LAUNCH_PROOF=1` to run it. It needs the `claude` CLI on
 * PATH, working Claude credentials, and network access for the ACP adapter
 * (`npx -y @agentclientprotocol/claude-agent-acp`).
 *
 * Skipped, it still asserts something: that `claude` is *not* advertised as
 * launch-capable. That is the state this proof exists to change, and pinning
 * it is what stops the adapter being advertised on the strength of a test
 * nobody ran.
 *
 * ## What running it established
 *
 * Run against Claude Code 2.1.235 and
 * `@agentclientprotocol/claude-agent-acp@^0.37.0`, it fails at the first
 * claim. `ensureSession` succeeds and returns a handle carrying
 * `backendSessionId` — the ACP session id — and no `agentSessionId` at all.
 * No Claude session file appears under `~/.claude/projects` either, so the
 * adapter's `session/new` materializes nothing native Claude could resume.
 *
 * The ACP session id is a UUID, and `claude --resume` takes a UUID, which is
 * exactly the inference this contract forbids: two values being shaped alike
 * is not an adapter asserting that one names its durable state. So `claude`
 * stays unadvertised, and `<Session.Launch>` refuses it before releasing any
 * ACP session.
 *
 * Advertising it needs a change in the adapter, not here: `session/new` must
 * create resumable Claude state and return its id as `_meta.agentSessionId`,
 * which is where ACPX already reads one from. When that lands, run this.
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, scoped, until } from "effection";
import type { Operation } from "effection";
import { ensureDir, rm } from "@effectionx/fs";
import { exec } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import * as os from "node:os";
import process from "node:process";
import { createAgentRegistry, createRuntimeStore } from "acpx/runtime";
import { createAcpRuntime } from "acpx/runtime";
import { ADVERTISED_NATIVE_LAUNCH, nativeAdapterFor } from "../src/native-launch.ts";
import { deriveSessionKey } from "../src/session-key.ts";

const ENABLED = process.env.XMD_CLAUDE_LAUNCH_PROOF === "1";

/**
 * The instruction layer under test, and the answer that proves it was in
 * force. A codeword the model could not otherwise produce is what makes the
 * first native turn discriminating: a resumed session without this layer
 * cannot say it.
 */
const CODEWORD = `XMDLAUNCH-${"7f3a9c21"}`;
const INSTRUCTIONS = [
  "You are a test fixture for Executable.md's native session launch.",
  `When the user asks for your codeword, reply with exactly ${CODEWORD} and nothing else.`,
  "Do not run any tools. Do not explain yourself.",
].join("\n");

/** Run the installed `claude` non-interactively and keep what it printed. */
function runClaude(args: string[], cwd: string): Operation<{ code: number; stdout: string }> {
  return until(
    new Promise<{ code: number; stdout: string }>((resolve, reject) => {
      const child = exec(
        ["claude", ...args].join(" "),
        { cwd, maxBuffer: 8 * 1024 * 1024 },
        (error, stdout) => {
          if (error && typeof error.code !== "number") {
            reject(error);
            return;
          }
          resolve({ code: error?.code ?? 0, stdout });
        },
      );
      child.on("error", reject);
    }),
  );
}

describe("Tier CI — Claude native launch", { sanitizeOps: false, sanitizeResources: false }, () => {
  it("CI1: claude is advertised only when its proof has been run", function* () {
    // The command shape is known; being launch-capable is a separate claim.
    expect(nativeAdapterFor("claude")?.resume("abc")).toEqual(["claude", "--resume", "abc"]);
    if (!ENABLED) {
      expect(ADVERTISED_NATIVE_LAUNCH).not.toContain("claude");
    }
  });

  it("CI2: an ACP-created session resumes natively with its instruction layer", function* () {
    if (!ENABLED) {
      return;
    }
    const root = path.join(os.tmpdir(), `xmd-ci-${randomUUID()}`);
    const work = path.join(root, "work");
    yield* ensureDir(work);
    yield* ensure(() => rm(root, { recursive: true, force: true }));
    {
      {
        const store = createRuntimeStore({ stateDir: path.join(root, "acpx") });
        const registry = createAgentRegistry();
        const runtime = createAcpRuntime({
          cwd: work,
          sessionStore: store,
          agentRegistry: registry,
          permissionMode: "deny-all",
          nonInteractivePermissions: "deny",
        });

        // 1 & 2: creation materializes durable state, and the adapter asserts
        // the identity that names it.
        const sessionKey = deriveSessionKey(registry.resolve("claude"), work);
        const handle = yield* until(
          runtime.ensureSession({
            sessionKey,
            agent: "claude",
            mode: "persistent",
            cwd: work,
            sessionOptions: { systemPrompt: INSTRUCTIONS },
          }),
        );
        expect(typeof handle.agentSessionId).toBe("string");
        const nativeSessionId = handle.agentSessionId!;
        // The native identity is its own: not the ACP session id beside it.
        expect(nativeSessionId).not.toBe(handle.backendSessionId);

        // 5: the ACP owner releases the session before native attachment.
        yield* until(runtime.close({ handle, reason: "native session launch proof" }));

        // 3: the prepared layer is in force on the *first* native user turn,
        // with no bootstrap turn in front of it — nothing above ran a prompt.
        const first = yield* runClaude(
          ["--resume", nativeSessionId, "-p", '"What is your codeword?"'],
          work,
        );
        expect(first.code).toBe(0);
        expect(first.stdout).toContain(CODEWORD);

        // 6: the native process exited without deleting the resumable session,
        // so 7 — ACP reattaching to the same state — is still possible.
        const reattached = yield* until(
          runtime.ensureSession({
            sessionKey,
            agent: "claude",
            mode: "persistent",
            cwd: work,
          }),
        );
        expect(reattached.agentSessionId).toBe(nativeSessionId);
        yield* until(runtime.close({ handle: reattached, reason: "proof complete" }));
      }
    }
  });
});
