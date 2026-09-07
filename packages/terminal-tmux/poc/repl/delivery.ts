/**
 * Issue #774 POC — literal terminal delivery.
 *
 * A message's bytes never touch a shell or a tmux argument vector. They are
 * written to a private mode-`0600` file, loaded from that file into a uniquely
 * named tmux buffer, and pasted from the buffer; the submit key is a separate
 * keystroke, so linefeeds in the message stay in the message rather than
 * submitting it. Bracketed paste is used where the terminal supports it.
 *
 * The paste itself is the final guarded operation: it rechecks the pane against
 * the guard convergence produced and either declines or pastes, with no
 * suspension in between. An unproved outcome is never a delivery — the caller
 * turns a decline into a message that stays queued, and a paste into an attempt
 * whose acceptance only the provider file can confirm.
 */

import { ensure, scoped, until } from "effection";
import type { Operation } from "effection";
import { rm, writeTextFile } from "@effectionx/fs";
import { chmod } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { GuardOutcome, PaneProbe, PaneSnapshot } from "./convergence.ts";

/** Everything one delivery attempt needs. */
export interface DeliveryRequest {
  /** The private mode-`0700` directory the message file is written under. */
  readonly dir: string;
  /** The message id, which names both the private file and the tmux buffer. */
  readonly id: string;
  /** The literal message bytes. Loaded from a file, never placed in an argv. */
  readonly bytes: string;
  /** Whether the pane's terminal supports bracketed paste. */
  readonly bracketedPaste: boolean;
  /** The key that submits the pasted message, sent on its own. */
  readonly submitKey: string;
  /** The converged snapshot the final guard rechecks against. */
  readonly guard: PaneSnapshot;
}

/** What a delivery attempt established, with report-safe evidence. */
export type DeliveryOutcome =
  | {
      readonly outcome: "pasted";
      /** The exact byte count delivered. */
      readonly byteCount: number;
      /** A hash of the delivered bytes; the bytes themselves never leave here. */
      readonly hash: string;
    }
  | { readonly outcome: "declined"; readonly reason: string };

/** A uniquely named tmux buffer for one message. */
export function bufferName(id: string): string {
  return `xmd-repl-${id}`;
}

/**
 * Deliver one message's literal bytes to a pane, under the final guard.
 *
 * The private file is this scope's: it is removed when the attempt settles,
 * whether the guard pasted or declined.
 */
export function deliver(probe: PaneProbe, request: DeliveryRequest): Operation<DeliveryOutcome> {
  return scoped(function* (): Operation<DeliveryOutcome> {
    const path = join(request.dir, `${request.id}.msg`);
    yield* writeTextFile(path, request.bytes);
    yield* until(chmod(path, 0o600));
    yield* ensure(() => rm(path, { force: true }));

    const buffer = bufferName(request.id);
    yield* probe.loadBuffer(buffer, path);
    const guarded: GuardOutcome = yield* probe.guardedPaste(request.guard, {
      buffer,
      bracketedPaste: request.bracketedPaste,
      submitKey: request.submitKey,
    });
    if (guarded.outcome === "declined") {
      return { outcome: "declined", reason: guarded.reason };
    }
    return {
      outcome: "pasted",
      byteCount: new TextEncoder().encode(request.bytes).length,
      hash: hashBytes(request.bytes),
    };
  });
}

/** The lowercase SHA-256 of the delivered bytes, for the report. */
export function hashBytes(bytes: string): string {
  return createHash("sha256").update(bytes, "utf8").digest("hex");
}
