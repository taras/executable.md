/**
 * What a person is told after submitting, and whether they can try again.
 *
 * Three of these are ordinary and one is not. A 204 means the workflow has the
 * answer and this tab has no further purpose. A 409 means the form was already
 * answered — by another tab, or by this one before a reload — and nothing the
 * person does here will change that. A 422 or a transport failure is the only
 * case where trying again makes sense, so it is the only case that leaves the
 * form usable.
 *
 * Pure and free of the DOM, so the mapping is tested directly rather than
 * inferred from what a page rendered.
 */

export type OutcomeKind = "accepted" | "already-submitted" | "retryable";

/**
 * How the status region is coloured. Two states, because there are only two
 * things a reader needs to tell apart: an answer that landed and one that did
 * not. `formUsable` already draws that line — an outcome that leaves the form
 * usable is one the person still has to act on.
 */
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
