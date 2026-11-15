import { cwd } from "@executablemd/runtime";
import { scoped } from "effection";
import { join, resolve } from "node:path";
import { useTempDirectory } from "../../../scripts/lib/temp-directory.ts";
import { readRegular, recordDraft, writeExclusive } from "./publication-files-deno.ts";
import {
  checkCheckout,
  checkCli,
  draftIdentity,
  gh,
  nativeAttachment,
  readDraft,
  verifyAttachment,
} from "./publication-host.ts";
import {
  checkAttachmentReferences,
  inspectBody,
  pending,
  renderEvidence,
} from "./publication-markdown.ts";
import { BODY_LIMIT, loadEvidence, type Evidence } from "./publication-receipt.ts";

type Body = ReturnType<typeof inspectBody>;

function renderDescription(evidence: Evidence, { before, after, slots }: Body): string {
  const body = before + renderEvidence(evidence, slots) + after;
  if (body.length > BODY_LIMIT) {
    throw new Error("The proposed draft description exceeds the GitHub body limit.");
  }
  return body;
}

export function* preparePublication(path: string, mode: "dry-run" | "publish") {
  const evidence = yield* loadEvidence(resolve(yield* cwd(), path));
  yield* checkCli();
  const { target, pins, identity, sources } = evidence;
  if (mode === "publish") {
    if (target.kind === "create") {
      const prepared = inspectBody(evidence, target.body);
      if (prepared.present) {
        throw new Error(
          "Supply prepared draft prose without an evidence section, or resume by PR number.",
        );
      }
      renderDescription(evidence, prepared);
      yield* checkCheckout(evidence);
    }
    return {
      kind: "publish",
      target,
      pins,
      identity,
      receipt: sources.receipt,
      receiptSha256: sources.receiptSha256,
    };
  }
  const body =
    evidence.previewBody === undefined
      ? target.kind === "create"
        ? target.body
        : ""
      : new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
          yield* readRegular(resolve(evidence.directory, evidence.previewBody), BODY_LIMIT),
        );
  const proposed = inspectBody(evidence, body);
  const { slots } = proposed;
  if (
    slots.some((url, index) => url !== pending(evidence.slots[index]) && !nativeAttachment(url))
  ) {
    throw new Error("A preview slot has a destination that cannot be verified.");
  }
  return {
    kind: "dry-run",
    identity,
    markdown: renderDescription(evidence, proposed),
    images: evidence.slots.flatMap((slot, index) =>
      slots[index] === pending(slot) ? [slot.path] : [],
    ),
    pins,
    sources,
  };
}

type SlotState = {
  id: string;
  sha256: string;
  state: "pending" | "verified" | "unverifiable";
  url?: string;
};

function* verifySlots(evidence: Evidence, body: Body) {
  const slots: SlotState[] = [];
  for (const [index, slot] of evidence.slots.entries()) {
    const url = body.slots[index];
    const fact = { id: slot.id, sha256: slot.sha256 };
    if (url === pending(slot)) {
      slots.push({ ...fact, state: "pending" });
      continue;
    }
    let verified = false;
    if (nativeAttachment(url)) {
      try {
        verified = yield* verifyAttachment(url, slot.sha256, slot.bytes.length);
      } catch {
        // A failed download provides no evidence about the slot.
      }
    }
    slots.push(verified ? { ...fact, state: "verified", url } : { ...fact, state: "unverifiable" });
  }
  return slots;
}

function status(slots: SlotState[]) {
  if (slots.some((slot) => slot.state === "unverifiable")) {
    return "unverifiable";
  }
  return slots.some((slot) => slot.state === "pending") ? "partial" : "complete";
}

export function* publishEvidence(
  receipt: string,
  identity: string,
  receiptSha256: string,
  number: number,
) {
  const evidence = yield* loadEvidence(receipt);
  if (evidence.identity !== identity || evidence.sources.receiptSha256 !== receiptSha256) {
    throw new Error("Evidence changed after preflight. Validate the pinned receipt again.");
  }
  const target = draftIdentity(evidence, number);
  const unchanged = {
    kind: "publication",
    target,
    identity,
    sources: evidence.sources,
    screenshots: evidence.slots.map(({ id, path }) => ({ id, path })),
  };
  const unknown = (reason: string, exitCode: number | null = null) => ({
    ...unchanged,
    status: "unverifiable",
    reason,
    exitCode,
    slots: evidence.slots.map(({ id, sha256 }) => ({ id, sha256, state: "unverifiable" })),
  });

  let original: string;
  let current: Body;
  try {
    original = (yield* readDraft(evidence, number)).body;
    current = inspectBody(evidence, original);
  } catch {
    return unknown(
      "Read and reconcile the exact draft, revision and evidence section before retrying.",
    );
  }

  const held = yield* verifySlots(evidence, current);
  if (status(held) !== "partial") {
    return {
      ...unchanged,
      status: status(held),
      exitCode: null,
      slots: held,
      ...(status(held) === "unverifiable"
        ? { reason: "Verify the attachment bytes for the flagged slots before retrying." }
        : {}),
    };
  }
  const body = renderDescription(evidence, current);

  const editExit = yield* scoped(function* () {
    const scratch = yield* useTempDirectory("xmd-repl-evidence-");
    checkAttachmentReferences(body, evidence, current.slots, scratch, yield* cwd());
    if (evidence.target.kind === "create") {
      yield* recordDraft(
        resolve(evidence.directory, evidence.target.draftRecord),
        JSON.stringify(
          {
            ...target,
            identity,
          },
          null,
          2,
        ) + "\n",
      );
    }
    const markdown = join(scratch, "description.md");
    yield* writeExclusive(markdown, body);
    const args = [
      "pr",
      "edit",
      String(number),
      "--repo",
      `github.com/${target.repository}`,
      "--body-file",
      markdown,
    ];
    for (const [index, slot] of evidence.slots.entries()) {
      if (held[index].state === "pending") {
        const path = join(scratch, slot.filename);
        yield* writeExclusive(path, slot.bytes);
        args.push("--attach", path);
      }
    }
    try {
      return (yield* gh(args)).exitCode;
    } catch {
      return null;
    }
  });

  let after: Body;
  try {
    const readback = (yield* readDraft(evidence, number)).body;
    after = inspectBody(evidence, readback);
    if (!after.present && !current.present && readback === original) {
      return { ...unchanged, status: "partial", exitCode: editExit, slots: held };
    }
    if (
      !after.present ||
      after.before !== current.before ||
      after.after !== current.after ||
      held.some((slot, index) => slot.state === "verified" && slot.url !== after.slots[index])
    ) {
      return unknown(
        "The published section or surrounding description changed during the edit.",
        editExit,
      );
    }
  } catch {
    return unknown(
      "Readback could not verify the exact draft, revision and evidence section.",
      editExit,
    );
  }
  const slots = yield* verifySlots(evidence, after);
  return {
    ...unchanged,
    status: status(slots),
    exitCode: editExit,
    slots,
    ...(status(slots) === "unverifiable"
      ? { reason: "Verify the attachment bytes for the flagged slots before retrying." }
      : {}),
  };
}
