import { canonicalize } from "@executablemd/core";
import { API } from "@executablemd/runtime";
import { z } from "zod";
import {
  describe,
  descriptor,
  read,
  same,
  stateLimit,
} from "../../../components/Ticket/text-storage.ts";

export const props = {
  type: "object",
  properties: {
    path: { type: "string", pattern: "^/" },
    reservation: { type: "string", pattern: "^/" },
    expected: { type: "object" },
  },
  required: ["path", "reservation", "expected"],
  additionalProperties: false,
};
export const returns = { type: "object" };
const reference = descriptor
  .extend({
    path: z.string().startsWith("/"),
    utf8Bytes: z.number().int().positive().max(stateLimit),
  })
  .strict();

export default function* ResumeRequest(value: unknown) {
  const input = z
    .strictObject({
      path: z.string().startsWith("/"),
      reservation: z.string().startsWith("/"),
      expected: z.record(z.string(), z.json()),
    })
    .parse(value);
  const text = yield* read("/", input.path, stateLimit);
  const resume = z
    .strictObject({
      schema: z.literal("joined-response-resume.v1"),
      request: reference,
      authority: reference,
      failure: reference,
    })
    .parse(JSON.parse(text));
  if (
    resume.request.path !== input.reservation + "/request.json" ||
    new Set([input.path, resume.request.path, resume.authority.path, resume.failure.path]).size !==
      4
  ) {
    throw new Error(
      "Resumption must bind distinct evidence and this reservation's original request.",
    );
  }
  const contents: Record<string, string> = {};
  for (const expected of [resume.request, resume.authority, resume.failure]) {
    const content = yield* read("/", expected.path, expected.utf8Bytes);
    if (!same(expected, describe(expected.path, content))) {
      throw new Error("Resumption evidence changed: " + expected.path);
    }
    contents[expected.path] = content;
  }
  if (
    JSON.stringify(canonicalize(JSON.parse(contents[resume.request.path]))) !==
    JSON.stringify(canonicalize(input.expected))
  ) {
    throw new Error(
      "The original reserved request no longer corresponds to this record, proof and owner.",
    );
  }
  const expected = z
    .object({ record: z.object({ continuation: z.object({ sha256: z.string() }) }) })
    .parse(input.expected);
  z.object({
    holdDigest: z.literal(expected.record.continuation.sha256),
    recoveryExitCode: z.literal(1),
    recoveryProviderPrompts: z.literal(0),
    allOriginalsUnchanged: z.literal(true),
    returnedConfirmedSuccessor: z.literal(false),
    nextWorkflowStepStarted: z.literal(false),
    outcome: z.literal("RECOVERY_BLOCKED_BEFORE_PUBLICATION"),
    reservationFiles: z.tuple([z.literal("request.json")]),
  }).parse(JSON.parse(contents[resume.failure.path]));
  const entries = yield* API.Fs.operations.readDirectory(input.reservation);
  if (
    entries.length !== 1 ||
    entries[0].name !== "request.json" ||
    !entries[0].isFile ||
    entries[0].isSymbolicLink
  ) {
    throw new Error(
      "Only an unchanged request-only reservation can resume; publication or resumption may already have started.",
    );
  }
  return {
    file: describe(input.path, text),
    request: resume.request,
    references: [resume.authority, resume.failure],
  };
}
