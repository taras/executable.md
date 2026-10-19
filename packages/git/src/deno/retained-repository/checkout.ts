import { until } from "effection";
import type { Operation } from "effection";
import { realpath } from "node:fs/promises";
import { GitOperationAdmissionError } from "../../composition/errors.ts";
import type { RepositorySelection } from "../../composition/selection.ts";
import type { ReplPushPlace } from "../../retained-repository/push-records.ts";
import type { ReplPushPlacement } from "../../retained-repository/push-admission.ts";
import { locatorFingerprint } from "../composition/locator.ts";
import { selectCheckout } from "../run-composition/operations.ts";
import { holdManagedPlacement } from "./leases.ts";
import type { ReplGitCheckout } from "./git.ts";
import type { ReplPushEntry } from "./push.ts";
import { placementSubject } from "./selections.ts";
import type { ReplPlacementRegistration } from "./selections.ts";

export function* route(
  entry: ReplPushEntry,
  received: ReplPushPlace,
  element: string,
): Operation<ReplGitCheckout> {
  const registered = entry.checkouts();
  const selected = selectCheckout(
    registered.map((checkout) => checkout.checkout),
    received.repository,
    yield* canonical(received.workingDirectory),
    element,
  );
  const found = registered.find((checkout) => checkout.checkout.root === selected.root);
  if (found === undefined) {
    throw new GitOperationAdmissionError(
      element,
      "the checkout it selected is not one this entry holds a placement for",
    );
  }
  return found;
}

export function* own(entry: ReplPushEntry, target: ReplGitCheckout): Operation<void> {
  const registration = target.registration;
  const slot = registration.slot;
  const root = registration.placement.managedRoot;
  if (slot === undefined || root === undefined) {
    return;
  }
  yield* holdManagedPlacement(() =>
    entry.holdSlot(root, slot.kind, slot.path, placementSubject(registration.placement)),
  );
}

function* canonical(path: string): Operation<string> {
  try {
    return yield* until(realpath(path));
  } catch {
    return path;
  }
}

function authenticated(
  entry: ReplPushEntry,
  selection: RepositorySelection,
  element: string,
): ReplPlacementRegistration {
  return entry.selections.authenticate(
    selection,
    () =>
      new GitOperationAdmissionError(
        element,
        "the Repository in scope is not one this entry selected, so it names no checkout",
      ),
  );
}

export function placements(entry: ReplPushEntry): readonly ReplPushPlacement[] {
  return entry.checkouts().map((checkout) => ({
    identity: checkout.registration.placement.identity,
    checkoutRoot: checkout.registration.placement.checkoutRoot,
    commonDirectory: checkout.registration.placement.commonDirectory,
  }));
}

export function placeOf(
  entry: ReplPushEntry,
  selection: RepositorySelection,
  workingDirectory: string,
  element: string,
): ReplPushPlace {
  const registration = authenticated(entry, selection, element);
  return Object.freeze({
    repository: registration.placement.identity,
    selectionCheckout: registration.placement.checkoutRoot,
    commonDirectory: registration.placement.commonDirectory,
    workingDirectory,
  });
}

export function* checkoutOrigin(
  registration: ReplPlacementRegistration,
  element: string,
  missing: string,
  mismatch: string,
): Operation<string> {
  const origin = yield* registration.origin();
  if (origin === undefined) {
    throw new GitOperationAdmissionError(element, missing);
  }
  if (locatorFingerprint(origin) !== registration.placement.identity.locatorFingerprint) {
    throw new GitOperationAdmissionError(element, mismatch);
  }
  return origin;
}
