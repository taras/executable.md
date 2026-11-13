import { z } from "zod";

export const props = { type: "object", properties: {}, additionalProperties: false };

const text = z.string().regex(/\S/).max(8_000);
const revision = z.string().regex(/^[a-f0-9]{40}$/);
const absolute = z.string().startsWith("/");
const session = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/);
const request = z.strictObject({
  role: z.literal("problem-solver"),
  session: session.max(96),
  attempt: absolute,
  previous: absolute.optional(),
  inputPaths: z.array(text).max(12),
  assignment: z.strictObject({
    work: text,
    repository: absolute,
    revision,
    spec: text.optional(),
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
  }),
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
const evidence = z.array(
  z.strictObject({
    path: text,
    characters: z.number().int().nonnegative(),
    bytes: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }),
);
const inputs = z
  .array(z.strictObject({ path: text, content: z.string() }))
  .min(1)
  .max(12);
const prior = z.strictObject({
  schema: z.literal("diagnosis-attempt.v1"),
  assignment: request.shape.assignment,
  primarySession: session,
  position: z.number().int().min(0).max(1),
  identities: absolute,
  previous: absolute.nullable(),
  evidence,
  solver: z.strictObject({
    provider: z.enum(["claude", "codex"]),
    model: z.string().min(1),
    effort: z.literal("high"),
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
  assignment: prior,
  model: text,
  identity,
  result,
});

function json(schema: z.ZodType) {
  return z.toJSONSchema(schema, { target: "draft-7" });
}

export default function* Schema() {
  return {
    request: json(request),
    result: json(result),
    prior: json(prior),
    inputs: json(inputs),
    identity: json(identity),
    receipt: json(receipt),
  };
}
