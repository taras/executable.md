import { z } from "zod";

export const props = { type: "object", properties: {}, additionalProperties: false };

const text = z.string().regex(/\S/).max(8_000);
const revision = z.string().regex(/^[a-f0-9]{40}$/);
const absolute = z.string().startsWith("/");
const session = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/);
const key = z.string().regex(/^[a-z0-9][a-z0-9-]{0,9}$/);
const provider = z.enum(["claude", "codex"]);
const profile = z.strictObject({
  key,
  provider,
  models: z.array(text).min(1),
  effort: text,
  quotaNotice: text.optional(),
});
const solvers = z.strictObject({ primary: profile, fallback: profile.optional() });
const specSection = text.regex(/^[^/#][^#]*\.md#[^#\s]+$/);
const source = z.strictObject({ work: text, repository: absolute, revision });
const diagnosis = source.extend({
  spec: specSection.optional(),
  failingRevision: revision.optional(),
  probes: z
    .array(
      z.strictObject({
        command: text,
        setup: text.optional(),
        artifacts: z.array(text).min(1).max(12).optional(),
      }),
    )
    .max(12)
    .optional(),
  request: text,
});
const design = source.extend({
  kind: z.literal("design"),
  question: text,
  constraints: z.array(text).max(12),
  specs: z.array(specSection).min(1).max(6).optional(),
});
const request = z.strictObject({
  role: z.literal("problem-solver"),
  session: session.max(96),
  attempt: absolute,
  previous: absolute.optional(),
  inputPaths: z.array(text).max(12),
  assignment: z.union([diagnosis, design]),
});
const result = z.discriminatedUnion("outcome", [
  z.strictObject({
    outcome: z.literal("cause"),
    revision,
    cause: text,
    evidence: z.array(text).min(1).max(12),
    regression: z.strictObject({ command: text, expected: text, observed: text }),
    handoff: text,
  }),
  z.strictObject({
    outcome: z.literal("missing_witness"),
    revision,
    witness: text,
    howToObtain: text,
  }),
]);
const designResult = z.strictObject({
  outcome: z.literal("design"),
  revision,
  options: z
    .array(z.strictObject({ option: text, tradeoffs: text }))
    .min(2)
    .max(4),
  observations: z
    .array(z.strictObject({ source: text, observation: text }))
    .min(1)
    .max(12),
  recommendation: text,
  whatWouldChange: text,
  openQuestions: z.array(text).max(12),
});
const evidence = z.array(
  z.strictObject({
    path: text,
    characters: z.number().int().nonnegative(),
    bytes: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }),
);
const designInputs = z.array(z.strictObject({ path: text, content: z.string() })).max(12);
const inputs = designInputs.min(1);
const prior = z.strictObject({
  schema: z.literal("diagnosis-attempt.v1"),
  assignment: request.shape.assignment,
  primarySession: session,
  position: z.number().int().min(0).max(1),
  identities: absolute,
  solverKey: key.optional(),
  previous: absolute.nullable(),
  evidence,
  solver: z.strictObject({
    provider,
    model: z.string().min(1),
    effort: text,
    session,
  }),
});
const identity = z.looseObject({
  schema: z.literal("phase-session.v2"),
  agent: text,
  name: session,
  cwd: absolute,
  attempted: z.literal(true),
  identity: z.strictObject({ kind: text, value: text }),
});

const receipt = z.strictObject({
  schema: z.literal("diagnosis-result.v1"),
  assignment: prior.extend({ assignment: diagnosis }),
  model: text,
  identity,
  result,
});
const designReceipt = receipt.extend({
  assignment: prior.extend({ assignment: design }),
  result: designResult,
});

function json(schema: z.ZodType) {
  return z.toJSONSchema(schema, { target: "draft-7" });
}

export default function* Schema() {
  return {
    request: json(request),
    solvers: json(solvers),
    result: json(result),
    designResult: json(designResult),
    prior: json(prior),
    inputs: json(inputs),
    designInputs: json(designInputs),
    identity: json(identity),
    receipt: json(z.union([receipt, designReceipt])),
  };
}
