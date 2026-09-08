/**
 * Issue #774 POC — the terminal-boundary evidence, after the VIEW_ONLY closeout.
 *
 * The POC concluded VIEW_ONLY (see `RESULT.md`): passive session-file observation
 * is sound, but reliable message dispatch cannot be established over black-box
 * tmux input and stays ACP-owned. The live-delivery journey that launched a real
 * coding agent and pasted a message is therefore removed — no agent is launched
 * and no model turn is spent by anything here.
 *
 * What remains is the terminal boundary as evidence: the pane probe the
 * convergence algorithm speaks to, expressed over an injectable tmux command
 * seam, and a real activity source that reads the server's own control-mode
 * generations. `guardedPaste` is the single server-side conditional the boundary
 * would use — it rechecks the pane and pastes or declines in one command — and it
 * is exercised by the deterministic boundary tests, never against a live agent.
 */

import { exec } from "@effectionx/process";
import { lines } from "@effectionx/stream-helpers";
import { resource, spawn } from "effection";
import type { Operation } from "effection";
import type { GuardOutcome, PaneProbe, PaneSnapshot, PasteRequest } from "./convergence.ts";

/**
 * One tmux command run against a server, and its acknowledged result.
 *
 * The single seam the pane probe is built on. A test supplies a fake that returns
 * canned command outputs, so the probe's guard contract is exercised without a
 * real server.
 */
export type TmuxCommand = (args: readonly string[]) => Operation<{ code: number; stdout: string }>;

/**
 * The pane's real output and visible-client activity generations.
 *
 * Counted from the server's own control-mode events — `%output` and the
 * `%client-*` family — not from `history_size` or a timestamp.
 */
export interface PaneActivity {
  read(): Operation<{ outputEvents: number; clientActivity: number }>;
}

/**
 * A `PaneProbe` over an injectable tmux command seam and activity source.
 *
 * `guardedPaste` is one server-side `if-shell` conditional: it rechecks the pane
 * generation (`pane_id`), process, liveness and mode, then pastes the pre-loaded
 * buffer, sends the submit key and prints an acknowledgement — or takes the
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
 * Evidence that the boundary reads real output and visible-client generations
 * rather than `history_size` or a timestamp: it attaches one no-output control
 * client and counts the `%output` and `%client-*` events the server reports. The
 * client is this scope's and is torn down with it. Unused by the deterministic
 * suite (which supplies a fake activity source) and never reached by a live
 * journey after the VIEW_ONLY closeout.
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
