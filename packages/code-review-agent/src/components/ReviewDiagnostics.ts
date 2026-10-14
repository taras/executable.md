import type { Operation } from "effection";
import type { Diagnostics, DoctorResult, OxlintDiagnostic, PR } from "../types.ts";
import { buildDiagnostics } from "../parse-diagnostics.ts";
import { returns as rawDiagnosticsSchema } from "./OxlintDiagnostics.ts";
import { returns as doctorSchema } from "./Doctor.ts";

export const props = {
  type: "object",
  properties: {
    raw: rawDiagnosticsSchema,
    pr: { type: "object" },
    doctor: doctorSchema,
  },
  required: ["raw", "pr", "doctor"],
  additionalProperties: false,
};

const groupSchema = {
  type: "object",
  properties: {
    ruleId: { type: "string" },
    count: { type: "number" },
    files: { type: "array", items: { type: "string" } },
    instances: rawDiagnosticsSchema,
  },
  required: ["ruleId", "count", "files", "instances"],
  additionalProperties: false,
};
const groupsSchema = { type: "array", items: groupSchema };

export const returns = {
  type: "object",
  properties: {
    groups: groupsSchema,
    total: { type: "number" },
    fileCount: { type: "number" },
    ruleCount: { type: "number" },
    byCategory: {
      type: "object",
      properties: {
        structural: groupsSchema,
        verbosity: groupsSchema,
        typeAware: groupsSchema,
        other: groupsSchema,
      },
      required: ["structural", "verbosity", "typeAware", "other"],
      additionalProperties: false,
    },
    summary: { type: "string" },
    density: { type: "number" },
  },
  required: ["groups", "total", "fileCount", "ruleCount", "byCategory", "summary", "density"],
  additionalProperties: false,
};

interface ReviewDiagnosticsProps {
  raw: OxlintDiagnostic[];
  pr: PR;
  doctor: DoctorResult;
}

export default function* ReviewDiagnostics({
  raw,
  pr,
  doctor,
}: ReviewDiagnosticsProps): Operation<Diagnostics> {
  return buildDiagnostics(raw, pr, doctor);
}
