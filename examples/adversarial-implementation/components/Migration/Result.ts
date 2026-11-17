import { z } from "zod";
import { designInputs, designReceipt } from "../Diagnosis/Schema.ts";
import extract from "../Phase/Extract.ts";
import fingerprint from "../Ticket/Fingerprint.ts";
import { read, unused } from "../Ticket/text-storage.ts";

const text = z.string().min(1);
const request = z.strictObject({
  repository: text,
  parent: text,
  directory: text,
  identities: text,
  session: text,
  name: text,
  question: text,
  constraints: z.array(text),
  inputs: designInputs,
  candidates: z.array(
    z.strictObject({
      key: text,
      provider: text,
      models: z.array(text),
      effort: text,
    }),
  ),
});

const completed = z.strictObject({
  catalog: z.looseObject({ state: z.literal("selected"), model: text }),
  turn: z.strictObject({ state: z.literal("reply"), reply: text }),
});
const extractedReply = z.object({ ok: z.literal(true), json: text });
const options = z.strictObject({ input: request });

export const props = z.toJSONSchema(options, { target: "draft-7" });

export default function* Result(value: unknown) {
  const { input } = options.parse(value);
  const expectedEvidence = yield* fingerprint({ inputs: input.inputs });
  for (const [position, candidate] of input.candidates.entries()) {
    const attempt = input.directory + "/" + candidate.key;
    const path = attempt + "/result.json";
    if (yield* unused(input.repository, path)) {
      continue;
    }
    const receipt = designReceipt.parse(JSON.parse(yield* read(input.repository, path)));
    const record = receipt.assignment;
    const assignment = record.assignment;
    const session = input.name + "-" + candidate.key;
    const savedAssignment = designReceipt.shape.assignment.parse(
      JSON.parse(yield* read(input.repository, attempt + "/assignment.json", 1_048_576)),
    );
    const inputs = designInputs.parse(
      JSON.parse(yield* read(input.repository, attempt + "/inputs.json")),
    );
    const savedIdentity = designReceipt.shape.identity.parse(
      JSON.parse(
        yield* read(
          input.repository,
          input.identities + "/" + encodeURIComponent(session) + ".json",
          1_048_576,
        ),
      ),
    );
    const execution = completed.parse(
      JSON.parse(yield* read(input.repository, attempt + "/outcome.json")),
    );
    const raw = yield* read(input.repository, attempt + "/raw.txt");
    const extracted = extractedReply.parse(yield* extract({ text: execution.turn.reply }));
    const reply = designReceipt.shape.result.parse(JSON.parse(extracted.json));
    const dryRun = receipt.result.dryRun;
    if (
      assignment.work !== input.parent ||
      assignment.question !== input.question ||
      JSON.stringify(assignment.constraints) !== JSON.stringify(input.constraints) ||
      assignment.revision !== receipt.result.revision ||
      record.primarySession !== input.session ||
      record.previous !== null ||
      record.position !== position ||
      record.solverKey !== candidate.key ||
      record.identities !== input.identities ||
      record.solver.provider !== candidate.provider ||
      record.solver.effort !== candidate.effort ||
      record.solver.model !== candidate.models[0] ||
      record.solver.session !== session ||
      !candidate.models.includes(receipt.model) ||
      execution.catalog.model !== receipt.model ||
      raw !== execution.turn.reply ||
      JSON.stringify(reply) !== JSON.stringify(receipt.result) ||
      receipt.identity.agent !== candidate.provider ||
      receipt.identity.name !== session ||
      receipt.identity.cwd !== assignment.repository ||
      JSON.stringify(savedAssignment) !== JSON.stringify(record) ||
      JSON.stringify(savedIdentity) !== JSON.stringify(receipt.identity) ||
      JSON.stringify(inputs) !== JSON.stringify(input.inputs) ||
      JSON.stringify(record.evidence) !== JSON.stringify(expectedEvidence) ||
      dryRun === undefined ||
      dryRun.pass.trim() === dryRun.fail.trim()
    ) {
      throw new Error(
        "The saved migration design at " +
          path +
          " differs from its scope, evidence, joined reply, session or required dry run.",
      );
    }
    return path;
  }
  return null;
}
