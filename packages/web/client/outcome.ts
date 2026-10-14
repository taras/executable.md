/**
 * A 204 or 409 ends this tab's work; validation and transport failures leave the
 * form usable so the person can retry. This mapping needs no DOM.
 */

export type OutcomeKind = "accepted" | "already-submitted" | "retryable";

/** A retryable outcome needs action; either terminal outcome uses `accepted`. */
export type Banner = "accepted" | "failed";

export interface Outcome {
  kind: OutcomeKind;
  message: string;
  /** Whether the person can correct their answer and submit again. */
  formUsable: boolean;
  /** Whether this tab has finished its job and may close. */
  closable: boolean;
}

export const ACCEPTED_MESSAGE = "Submission received. You can safely close this tab.";
export const ALREADY_SUBMITTED_MESSAGE =
  "This form was already submitted. You can safely close this tab.";
export const INVALID_MESSAGE = "The server rejected this submission. Correct it and try again.";
export const TRANSPORT_MESSAGE = "The submission could not be delivered. Try again.";

export function bannerFor(outcome: Outcome): Banner {
  return outcome.formUsable ? "failed" : "accepted";
}

export function outcomeFor(status: number): Outcome {
  if (status === 204) {
    return { kind: "accepted", message: ACCEPTED_MESSAGE, formUsable: false, closable: true };
  }
  if (status === 409) {
    return {
      kind: "already-submitted",
      message: ALREADY_SUBMITTED_MESSAGE,
      formUsable: false,
      closable: true,
    };
  }
  if (status === 422) {
    return { kind: "retryable", message: INVALID_MESSAGE, formUsable: true, closable: false };
  }
  // Everything else — a refused origin, a media-type rejection, a size refusal,
  // a dead connection reported as status 0 — is something the person may be able
  // to get past, and none of it is a reason to take their answer away.
  return { kind: "retryable", message: TRANSPORT_MESSAGE, formUsable: true, closable: false };
}
