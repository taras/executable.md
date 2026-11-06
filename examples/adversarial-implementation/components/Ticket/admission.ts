import { parseFilesFailure } from "@executablemd/runtime";
import type { Operation } from "effection";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { amendment, envelope, measurement, programFile, selection, state } from "./control.ts";
import { describe, descriptor, read, stateLimit, textLimit } from "./text-storage.ts";

type Descriptor = z.infer<typeof descriptor>;
type Amendment = z.infer<typeof amendment>;
type State = z.infer<typeof state>;

const commit = z.string().regex(/^[0-9a-f]{40}$/);
const example = "examples/adversarial-implementation/";

export const workflowRoot = fileURLToPath(new URL("../../../../", import.meta.url));
export const programEntry = example + "amend-delivery.md";

export const program = [
  programEntry,
  example + "continue.md",
  example + "delivery.md",
  example + "components/Entry/Amend.md",
  example + "components/Entry/Continue.md",
  example + "components/Ticket/Amend.md",
  example + "components/Ticket/AmendmentPrepare.ts",
  example + "components/Ticket/AmendmentProgram.ts",
  example + "components/Ticket/AmendmentSettle.ts",
  example + "components/Ticket/AmendmentSources.ts",
  example + "components/Ticket/AmendmentState.ts",
  example + "components/Ticket/AmendmentFeedback.ts",
  example + "components/Ticket/admission.ts",
  example + "components/Ticket/measured-weights.ts",
  example + "components/Ticket/Continue.md",
  example + "components/Ticket/Walk.md",
  example + "components/Ticket/Step.md",
  example + "components/Ticket/Settle.md",
  example + "components/Ticket/Advance.md",
  example + "components/Ticket/LoadState.ts",
  example + "components/Ticket/control.ts",
  example + "components/Ticket/Publish.ts",
  example + "components/Delivery/Status.md",
];

export const authorization = z
  .object({
    schema: z.literal("delivery-amendment-authorization.v1"),
    work: z.string().min(1),
    repository: z.string().startsWith("/"),
    revision: commit,
    predecessor: descriptor,
    feedback: descriptor,
    purpose: z.literal("measured-test-weights"),
    delta: z.tuple([z.literal("test-weights.json")]),
    authority: z
      .object({
        kind: z.enum(["delegated-coordinator-selection", "direct-human-approval"]),
        document: descriptor,
      })
      .strict(),
    measurement,
    workflow: z.object({ old: descriptor, new: selection }).strict(),
  })
  .strict();

export const acquisition = z
  .object({
    schema: z.literal("weights-acquisition.v1"),
    run: z
      .object({
        commit,
        runUrl: z.string().min(1),
        attempt: z.number().int().positive(),
        runner: z.string().min(1),
      })
      .strict(),
    records: z
      .object({
        deno: z.object({ name: z.string(), sha256: z.string() }).strict(),
        node: z.object({ name: z.string(), sha256: z.string() }).strict(),
        bun: z.object({ name: z.string(), sha256: z.string() }).strict(),
      })
      .strict(),
    weights: z.object({ name: z.literal("test-weights"), sha256: z.string() }).strict(),
  })
  .strict();

export const launch = z
  .object({
    schema: z.literal("workflow-launch.v1"),
    work: z.string().min(1),
    directory: z.string().startsWith("/"),
    revision: commit,
    selection,
  })
  .strict();

export const request = z
  .object({
    schema: z.literal("delivery-amendment-request.v1"),
    work: z.string(),
    repository: z.string().startsWith("/"),
    base: commit,
    grant: descriptor,
    authority: authorization.shape.authority,
    predecessor: descriptor,
    feedback: descriptor,
    measurement,
    weights: descriptor,
    workflow: z.object({ old: descriptor, launch: selection, new: selection }).strict(),
    round: z
      .object({
        before: z.number().int().nonnegative(),
        after: z.number().int().positive(),
        max: z.number().int(),
      })
      .strict(),
  })
  .strict();

export const disposition = z
  .object({
    schema: z.literal("delivery-amendment-disposition.v1"),
    status: z.literal("admitted"),
    request: descriptor,
    predecessor: descriptor,
    successor: descriptor,
    envelope,
  })
  .strict();

export const finalFeedback = z
  .object({
    schema: z.literal("delivery-amendment-feedback.v1"),
    status: z.literal("feedback_ready"),
    revision: commit,
    base: commit,
    original: descriptor,
    request: descriptor,
    disposition: descriptor,
    continuation: descriptor,
    implementation: z.string().startsWith("/"),
    reviews: z.array(z.string().startsWith("/")),
  })
  .strict();

export function json(text: string, label: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(label + " is not one JSON value: " + (error instanceof Error ? error.message : String(error)));
  }
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function* verified(
  expected: Descriptor,
  label: string,
  limit = textLimit,
): Operation<string> {
  const text = yield* optional(expected.path, limit);
  if (text === undefined) {
    throw new Error(label + " is missing: " + expected.path);
  }
  const actual = describe(expected.path, text);
  if (actual.utf8Bytes !== expected.utf8Bytes || actual.sha256 !== expected.sha256) {
    throw new Error(label + " changed after it was recorded: " + expected.path);
  }
  return text;
}

export function* optional(path: string, limit = stateLimit): Operation<string | undefined> {
  try {
    return yield* read("/", path, limit);
  } catch (error) {
    if (parseFilesFailure(error)?.reason === "missing") {
      return undefined;
    }
    throw error;
  }
}

export function* observeProgram(): Operation<Array<z.infer<typeof programFile>>> {
  const files: Array<z.infer<typeof programFile>> = [];
  for (const path of program) {
    const { utf8Bytes, sha256 } = describe(path, yield* read("/", workflowRoot + path));
    files.push({ path, utf8Bytes, sha256 });
  }
  return files;
}

export function* confirmSources(recorded: z.infer<typeof selection>): Operation<void> {
  if (recorded.root !== workflowRoot || !same(recorded.files, yield* observeProgram())) {
    throw new Error(
      "The selected amendment workflow sources changed or another include directory is running. Preserve the admitted record; no role was dispatched for this check.",
    );
  }
}

function* admittedSuccessor(
  selected: Amendment,
  text: string,
): Operation<{ record: z.infer<typeof disposition>; successor: State }> {
  const record = disposition.parse(json(text, "The amendment disposition"));
  if (!same(record.request, selected.request) || !same(record.predecessor, selected.predecessor)) {
    throw new Error("The amendment disposition names another request or predecessor.");
  }
  yield* verified(record.request, "Amendment request");
  const successor = state.parse(
    json(yield* verified(record.successor, "Admitted successor", stateLimit), "The admitted successor"),
  );
  if (!same(successor.checkpoint.amendment, selected)) {
    throw new Error("The admitted successor binds another amendment.");
  }
  if (!same(record.envelope.continuation, record.successor)) {
    throw new Error("The amendment disposition returns another continuation.");
  }
  return { record, successor };
}

export function* confirmAdmission(saved: State): Operation<void> {
  const selected = saved.checkpoint.amendment;
  if (selected === undefined) {
    return;
  }
  const text = yield* optional(selected.disposition);
  if (text === undefined) {
    throw new Error(
      "This amended continuation has no confirmed admission disposition. Preserve the reservation for operator reconciliation; no role is dispatched.",
    );
  }
  const { successor } = yield* admittedSuccessor(selected, text);
  if (!same(successor.calls, saved.calls.slice(0, successor.calls.length))) {
    throw new Error("The amended continuation does not extend its admitted successor.");
  }
}

export interface ReservationState {
  state: "absent" | "hold" | "admitted" | "feedback";
  reason: string | null;
  envelope: z.infer<typeof envelope> | null;
  revision: string | null;
  feedback: string | null;
  fingerprint: string;
}

export function* classify(directory: string, present: boolean): Operation<ReservationState> {
  const absent: ReservationState = {
    state: "absent",
    reason: null,
    envelope: null,
    revision: null,
    feedback: null,
    fingerprint: "absent",
  };
  if (!present) {
    return absent;
  }
  const texts = {
    request: yield* optional(directory + "/request.json"),
    disposition: yield* optional(directory + "/disposition.json"),
    feedback: yield* optional(directory + "/feedback.json"),
  };
  const fingerprint = JSON.stringify(
    Object.values(texts).map((text) => (text === undefined ? null : describe("", text).sha256)),
  );
  const held = (reason: string): ReservationState => ({ ...absent, state: "hold", reason, fingerprint });
  if (texts.disposition === undefined) {
    return held(
      "The delivery amendment reservation has no confirmed disposition. Preserve " +
        directory +
        " for operator reconciliation; no admission, role or readiness is inferred from its files.",
    );
  }
  try {
    const record = disposition.parse(json(texts.disposition, "The amendment disposition"));
    const selected = state.parse(
      json(yield* verified(record.successor, "Admitted successor", stateLimit), "The admitted successor"),
    ).checkpoint.amendment;
    if (
      selected === undefined ||
      selected.reservation !== directory ||
      selected.disposition !== directory + "/disposition.json"
    ) {
      throw new Error("The admitted successor names another reservation.");
    }
    yield* admittedSuccessor(selected, texts.disposition);
    yield* verified(selected.feedback, "Original delivery feedback");
    if (texts.feedback === undefined) {
      return { ...absent, state: "admitted", envelope: record.envelope, fingerprint };
    }
    const final = finalFeedback.parse(json(texts.feedback, "The final amendment feedback"));
    const continued = state.parse(
      json(
        yield* verified(final.continuation, "Final feedback continuation", stateLimit),
        "The final feedback continuation",
      ),
    );
    if (
      !same(final.request, selected.request) ||
      !same(final.original, selected.feedback) ||
      !same(final.disposition, describe(directory + "/disposition.json", texts.disposition)) ||
      final.base !== selected.base ||
      !same(continued.checkpoint.amendment, selected) ||
      continued.checkpoint.status !== "feedback_ready" ||
      continued.checkpoint.revision !== final.revision
    ) {
      throw new Error("The final amendment feedback is not linked to its admitted lineage.");
    }
    return {
      ...absent,
      state: "feedback",
      envelope: record.envelope,
      revision: final.revision,
      feedback: directory + "/feedback.json",
      fingerprint,
    };
  } catch (error) {
    const failure = parseFilesFailure(error);
    if (failure !== undefined && failure.reason !== "missing") {
      throw error;
    }
    return held(
      "The delivery amendment record is incomplete or inconsistent: " +
        (error instanceof Error ? error.message : String(error)) +
        ". Preserve " +
        directory +
        " for operator reconciliation.",
    );
  }
}
