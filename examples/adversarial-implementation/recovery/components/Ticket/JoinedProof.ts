import { canonicalize } from "@executablemd/core";
import { z } from "zod";
import { parseDurableEvent } from "@executablemd/durable-streams";
import { parsePromptRecord } from "@executablemd/agent/host";
import {
  describe,
  descriptor,
  read,
  same,
  stateLimit,
  textLimit,
} from "../../../components/Ticket/text-storage.ts";

export const props = {
  type: "object",
  properties: {
    path: { type: "string", pattern: "^/" },
    mode: { enum: ["admit", "validate"] },
    record: { type: "object" },
    call: { type: "object" },
    request: { type: "string" },
    raw: { type: "string" },
  },
  required: ["path", "mode", "record", "call", "request", "raw"],
  additionalProperties: false,
};
export const returns = { type: "object" };
const reference = descriptor.extend({ path: z.string().startsWith("/") }).strict();
const nonempty = reference.extend({ utf8Bytes: z.number().int().positive().max(textLimit) });
const proofSchema = z.strictObject({
  schema: z.literal("joined-response-proof.v1"),
  amendment: nonempty,
  provenance: nonempty,
  join: nonempty,
  handoffInputs: z.array(reference).min(1).max(12),
});
const jsonObject = z.record(z.string(), z.json());
const location = z.strictObject({
  path: z.string().startsWith("/"),
  line: z.number().int().positive(),
});
const historicalJoinSchema = z.object({
  journal: location.extend({ lineDescriptor: descriptor.omit({ path: true }) }),
  retainedEvent: z.string().startsWith("/"),
  nativeFinishedSource: location.extend({
    utf8Bytes: z.number().int().nonnegative().max(textLimit),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }),
});

const runJoinSchema = z.strictObject({
  schema: z.literal("joined-response-run-proof.v1"),
  journal: location.extend({ lineDescriptor: descriptor.omit({ path: true }) }).strict(),
  retainedEvent: z.string().startsWith("/"),
  publicRunSource: nonempty,
});
const runSettlementSchema = z.strictObject({
  schema: z.literal("joined-response-run-settlement.v1"),
  root: nonempty,
  journal: nonempty,
  outcome: z.strictObject({
    kind: z.literal("settled"),
    result: z.strictObject({ ok: z.literal(true), value: jsonObject }),
  }),
});

function failure(message: string): never {
  throw new Error("Joined-response proof: " + message);
}

function* observed(expected: z.infer<typeof reference>) {
  const text = yield* read("/", expected.path, expected.utf8Bytes);
  if (!same(expected, describe(expected.path, text))) {
    failure("named evidence changed: " + expected.path);
  }
  return text;
}

export default function* JoinedProof(value: unknown) {
  const input = z
    .strictObject({
      path: z.string().startsWith("/"),
      mode: z.enum(["admit", "validate"]),
      record: jsonObject,
      call: z.object({
        role: z.literal("implementor"),
        session: z.string(),
        provider: z.enum(["claude", "codex"]),
        profile: z.strictObject({ provider: z.string(), model: z.string(), effort: z.string() }),
        assignment: z.object({
          repository: z.string(),
          identityDirectory: z.string(),
          artifactDirectory: z.string(),
        }),
      }),
      request: z.string(),
      raw: z.string(),
    })
    .parse(value);
  const text = yield* read("/", input.path, stateLimit);
  const proof = proofSchema.parse(JSON.parse(text));
  const references = [proof.amendment, proof.provenance, proof.join, ...proof.handoffInputs];
  if (new Set(references.map((item) => item.path)).size !== references.length) {
    failure("proof references must be distinct.");
  }
  const texts: Record<string, string> = {};
  for (const entry of references) {
    texts[entry.path] = yield* observed(entry);
  }
  if (input.mode === "admit") {
    return { file: describe(input.path, text), proof, references };
  }
  const report = JSON.parse(texts[proof.join.path]);
  const run = runJoinSchema.safeParse(report);
  if (
    !run.success &&
    (report.schema === "joined-response-run-proof.v1" || "publicRunSource" in report)
  ) {
    failure("mixed or invalid public run report.");
  }
  const join = run.success ? run.data : historicalJoinSchema.parse(report);
  const settlement = run.success
    ? runSettlementSchema.parse(JSON.parse(yield* observed(run.data.publicRunSource)))
    : undefined;
  const rootText = settlement === undefined ? undefined : yield* observed(settlement.root);
  const journalText = yield* read("/", join.journal.path, textLimit);
  if (!journalText.endsWith("\n")) {
    failure("the original journal has an unfinished final record.");
  }
  if (
    settlement !== undefined &&
    (settlement.journal.path !== join.journal.path ||
      !same(settlement.journal, describe(join.journal.path, journalText)) ||
      JSON.stringify(canonicalize(settlement.outcome.result.value)) !==
        JSON.stringify(canonicalize(input.record)))
  ) {
    failure("public run journal or returned envelope changed.");
  }
  const lines = journalText.split("\n");
  lines.pop();
  const promptText = lines[join.journal.line - 1];
  if (
    promptText === undefined ||
    !same(
      { path: join.journal.path, ...join.journal.lineDescriptor },
      describe(join.journal.path, promptText + "\n"),
    )
  ) {
    failure("the original event is not at its recorded journal location.");
  }
  const event = parseDurableEvent(promptText);
  if (
    !event.ok ||
    event.value.type !== "yield" ||
    event.value.description.type !== "agent_prompt" ||
    event.value.result.status !== "ok"
  ) {
    failure("the selected event is not a completed prompt record.");
  }
  const prompt = parsePromptRecord(event.value.result.value);
  if (
    prompt === undefined ||
    prompt.status !== "completed" ||
    prompt.withheld ||
    prompt.error !== undefined ||
    prompt.text !== input.raw ||
    event.value.description.input !== input.request
  ) {
    failure("the completed provider request/reply does not match the original call.");
  }
  if (
    prompt.agent !== input.call.provider ||
    prompt.configuration?.model !== input.call.profile.model ||
    prompt.configuration?.effort !== input.call.profile.effort
  ) {
    failure("the provider or delivered model/effort changed.");
  }
  const sessionPath =
    input.call.assignment.identityDirectory +
    "/" +
    encodeURIComponent(input.call.session) +
    ".json";
  const identityText = yield* read("/", sessionPath, stateLimit);
  const pair = z.strictObject({ kind: z.string(), value: z.string() });
  const identity = z
    .strictObject({
      schema: z.literal("phase-session.v2"),
      agent: z.string(),
      name: z.string(),
      cwd: z.string(),
      sessionKey: z.string(),
      identity: pair.nullable(),
      attempted: z.boolean(),
      started: z
        .strictObject({ sessionKey: z.string(), cwd: z.string(), identity: pair.nullable() })
        .nullable(),
    })
    .parse(JSON.parse(identityText));
  if (
    !identity.attempted ||
    identity.name !== input.call.session ||
    identity.agent !== prompt.agent ||
    identity.cwd !== input.call.assignment.repository ||
    identity.sessionKey !== prompt.sessionKey ||
    identity.identity === null ||
    identity.identity.kind !== "acpx.agentSessionId" ||
    identity.identity.value !== prompt.agentSessionId ||
    identity.started?.sessionKey !== prompt.sessionKey ||
    identity.started.cwd !== identity.cwd ||
    JSON.stringify(identity.started.identity) !== JSON.stringify(identity.identity)
  ) {
    failure("the original native session identity is missing or mismatched.");
  }
  const retainedEvent = yield* read("/", join.retainedEvent, textLimit);
  const retained = parseDurableEvent(retainedEvent);
  if (!retained.ok || JSON.stringify(retained.value) !== JSON.stringify(event.value)) {
    failure("the retained event export does not match the original journal.");
  }
  const originals = [
    describe(join.journal.path, journalText),
    describe(join.retainedEvent, retainedEvent),
    describe(sessionPath, identityText),
  ];
  let selectedEntry = 1;
  let expectedExecution: string | undefined;
  if (settlement === undefined) {
    const historical = historicalJoinSchema.parse(report);
    const nativeText = yield* read("/", historical.nativeFinishedSource.path, textLimit);
    const nativeLine = nativeText.split("\n")[historical.nativeFinishedSource.line - 1];
    if (
      nativeLine === undefined ||
      !same(
        {
          path: historical.nativeFinishedSource.path,
          utf8Bytes: historical.nativeFinishedSource.utf8Bytes,
          sha256: historical.nativeFinishedSource.sha256,
        },
        describe(historical.nativeFinishedSource.path, nativeText),
      )
    ) {
      failure("the original native completion receipt changed.");
    }
    const finished = z
      .object({
        kind: z.literal("finished"),
        joined: z.literal(true),
        outcome: z.literal("completed"),
        submission: z.object({ sessionId: z.string(), execution: z.string(), entry: z.string() }),
        result: z.object({ value: jsonObject }),
        error: z.null(),
        journal: z.literal("completed"),
      })
      .parse(JSON.parse(nativeLine));
    if (
      JSON.stringify(canonicalize(finished.result.value)) !==
      JSON.stringify(canonicalize(input.record))
    ) {
      failure("the joined native entry returned another Ticket envelope.");
    }
    selectedEntry = Number(finished.submission.entry.slice(6));
    if (
      !Number.isSafeInteger(selectedEntry) ||
      selectedEntry < 1 ||
      finished.submission.entry !== "entry-" + selectedEntry
    ) {
      failure("the original native entry identity is malformed.");
    }
    expectedExecution = finished.submission.execution;
    originals.push(describe(historical.nativeFinishedSource.path, nativeText));
  } else if (run.success && rootText !== undefined) {
    originals.push(run.data.publicRunSource, settlement.root);
  }
  let order = 0;
  let open = false;
  let member = false;
  let closed = false;
  const imports: { name: string; path: string; utf8Bytes: number; sha256: string }[] = [];
  const yields: Record<string, number> = {};
  let ownerFound = false;
  const sourceOwner = z
    .strictObject({ coroutineId: z.string(), index: z.number().int().nonnegative() })
    .parse(event.value.description["executablemd.source-owner"]);
  const position = z
    .object({
      path: z.string(),
      offset: z.number().int().nonnegative(),
      line: z.number().int().positive(),
      column: z.number().int().positive(),
    })
    .parse(event.value.description["executablemd.source-position"]);
  for (const [index, line] of lines.entries()) {
    const parsed = parseDurableEvent(line);
    if (!parsed.ok) {
      failure("the original journal contains an unreadable event.");
    }
    const item = parsed.value;
    if (
      item.type === "yield" &&
      item.description.type === "import_component" &&
      item.description.name === "__root__"
    ) {
      if (open || item.coroutineId !== "root") {
        failure("the original journal has contradictory entry boundaries.");
      }
      order += 1;
      if (
        settlement !== undefined &&
        (order !== 1 ||
          item.result.status !== "ok" ||
          !z
            .object({ path: z.literal(settlement.root.path), content: z.literal(rootText ?? "") })
            .safeParse(item.result.value).success)
      ) {
        failure("public run root source or membership changed.");
      }
      open = true;
      for (const key of Object.keys(yields)) {
        delete yields[key];
      }
    }
    if (!open) {
      failure("the original journal has an event outside an entry.");
    }
    const selected = selectedEntry === order;
    if (item.type === "yield") {
      const ordinal = yields[item.coroutineId] ?? 0;
      if (
        order <= selectedEntry &&
        item.description.type === "import_component" &&
        item.result.status === "ok"
      ) {
        const definition = z
          .object({ kind: z.literal("repository"), path: z.string(), content: z.string() })
          .safeParse(item.result.value);
        if (definition.success) {
          imports.push({
            name: item.description.name,
            ...describe(definition.data.path, definition.data.content),
          });
          if (
            selected &&
            item.coroutineId === sourceOwner.coroutineId &&
            ordinal === sourceOwner.index &&
            definition.data.path === position.path &&
            definition.data.content.slice(position.offset).startsWith("<Prompt")
          ) {
            ownerFound = true;
          }
        }
      }
      yields[item.coroutineId] = ordinal + 1;
    }
    if (index === join.journal.line - 1) {
      member = selected;
    }
    if (item.type === "close" && item.coroutineId === "root") {
      if (selected) {
        closed = item.result.status === "ok";
        if (settlement !== undefined) {
          const terminal =
            item.result.status === "ok"
              ? z
                  .strictObject({
                    status: z.literal("ok"),
                    output: z.string(),
                    value: jsonObject,
                    bindings: jsonObject,
                  })
                  .safeParse(item.result.value)
              : undefined;
          if (
            !terminal?.success ||
            JSON.stringify(canonicalize(terminal.data.value)) !==
              JSON.stringify(canonicalize(input.record))
          ) {
            failure("public run document did not return the held envelope.");
          }
        }
      }
      open = false;
    }
  }
  if (
    !member ||
    !closed ||
    !ownerFound ||
    (expectedExecution !== undefined &&
      join.journal.path.split("/").at(-2) !== expectedExecution) ||
    open
  ) {
    failure("the prompt lacks matching source, execution and joined-entry membership.");
  }
  return {
    file: describe(input.path, text),
    proof,
    references,
    raw: describe(input.call.assignment.artifactDirectory + "/raw.txt", input.raw),
    originals,
    imports,
    prompt: {
      sequence: prompt.sequence,
      sessionKey: prompt.sessionKey,
      agentSessionId: prompt.agentSessionId,
      configuration: prompt.configuration,
    },
  };
}
