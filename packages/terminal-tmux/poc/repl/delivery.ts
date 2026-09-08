/**
 * Issue #774 POC — literal terminal delivery.
 *
 * A message's bytes never touch a shell or a tmux argument vector. They are
 * written to a private mode-`0600` file, loaded from that file into a uniquely
 * named tmux buffer, and pasted from the buffer; the submit key is a separate
 * keystroke, so linefeeds in the message stay in the message rather than
 * submitting it. Bracketed paste is used where the terminal supports it.
 *
 * Preparation and the paste are separate phases on purpose. `withPreparedDelivery`
 * writes the private file and loads the buffer — registering their cleanup before
 * either exists, so a halt between acquiring and registering cannot strand them —
 * and then hands the caller a `PreparedDelivery`. The caller takes its final
 * provider/pane sample *after* preparation, so a turn that opens or a record that
 * grows while the buffer is loading is caught before anything is sent. Only then
 * does the caller record `AttemptStarted` and call `paste`.
 *
 * The paste itself is the final guarded operation: one server-side conditional
 * that rechecks the pane and either pastes, declines, or reports its own outcome
 * unreadable, with no suspension between the recheck and the paste. A decline
 * sent nothing and keeps the message queued; an uncertain outcome means bytes may
 * have gone and the message becomes uncertain, never retried.
 */

import { ensure, scoped, until } from "effection";
import type { Operation } from "effection";
import { rm, writeTextFile } from "@effectionx/fs";
import { chmod } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { PaneProbe, PaneSnapshot } from "./convergence.ts";

/** What one delivery needs to prepare and paste. */
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
  | { readonly outcome: "declined"; readonly reason: string }
  | { readonly outcome: "uncertain"; readonly reason: string };

/** A prepared delivery: the buffer is loaded, awaiting the guarded paste. */
export interface PreparedDelivery {
  /** The exact byte count that will be delivered. */
  readonly byteCount: number;
  /** A hash of the bytes; the bytes themselves never leave delivery. */
  readonly hash: string;
  /** Recheck the pane against `guard` and paste, decline, or report uncertain. */
  paste(guard: PaneSnapshot): Operation<DeliveryOutcome>;
}

/** A uniquely named tmux buffer for one message. */
export function bufferName(id: string): string {
  return `xmd-repl-${id}`;
}

/**
 * Prepare one message's private file and tmux buffer, then run `body`.
 *
 * The file and the buffer are this scope's: both are removed when the scope
 * settles, whether `body` pasted, declined, left the outcome uncertain, or was
 * cancelled mid-flight. Cleanup is registered before either resource exists.
 */
export function withPreparedDelivery<T>(
  probe: PaneProbe,
  request: DeliveryRequest,
  body: (prepared: PreparedDelivery) => Operation<T>,
): Operation<T> {
  return scoped(function* (): Operation<T> {
    const path = join(request.dir, `${request.id}.msg`);
    const buffer = bufferName(request.id);
    // Cleanup registered before either resource exists, so a halt between
    // acquiring and registering cannot leave the file or the buffer behind.
    yield* ensure(() => probe.deleteBuffer(buffer));
    yield* ensure(() => rm(path, { force: true }));

    yield* writeTextFile(path, request.bytes);
    yield* until(chmod(path, 0o600));
    yield* probe.loadBuffer(buffer, path);

    const byteCount = new TextEncoder().encode(request.bytes).length;
    const hash = hashBytes(request.bytes);
    const prepared: PreparedDelivery = {
      byteCount,
      hash,
      *paste(guard: PaneSnapshot): Operation<DeliveryOutcome> {
        const guarded = yield* probe.guardedPaste(guard, {
          buffer,
          bracketedPaste: request.bracketedPaste,
          submitKey: request.submitKey,
        });
        if (guarded.outcome === "declined") {
          return { outcome: "declined", reason: guarded.reason };
        }
        if (guarded.outcome === "uncertain") {
          return { outcome: "uncertain", reason: guarded.reason };
        }
        return { outcome: "pasted", byteCount, hash };
      },
    };
    return yield* body(prepared);
  });
}

/** The lowercase SHA-256 of the delivered bytes, for the report. */
export function hashBytes(bytes: string): string {
  return createHash("sha256").update(bytes, "utf8").digest("hex");
}
