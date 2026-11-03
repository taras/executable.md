import { content } from "@executablemd/core";
import type { Json, PropsSchema } from "@executablemd/core";
import { readTextFile, writeTextFile } from "@effectionx/fs";
import { cwd, platform } from "@executablemd/runtime";
import { randomUUID, createHash } from "node:crypto";
import { resolve } from "node:path";
import { configurationSchema, initialReport, finalizeReport } from "../report.ts";
import { Qualification } from "../state.ts";
import type { QualificationState } from "../state.ts";
import { observeQualification, joinQualification } from "../observe.ts";

export const props: PropsSchema = {
  type: "object",
  properties: {
    configuration: { type: "object" },
    configFingerprint: { type: "string" },
    report: { type: "string" },
  },
  required: ["configuration", "configFingerprint", "report"],
  additionalProperties: false,
};

export default function* Qualify(input: Record<string, Json>) {
  const configuration = configurationSchema.parse(input.configuration);
  const report = initialReport(configuration);
  const fingerprint = input.configFingerprint;
  if (typeof fingerprint !== "string" || !/^[a-f0-9]{64}$/u.test(fingerprint)) {
    throw new Error("Missing configuration fingerprint");
  }
  report.fingerprints.configuration = fingerprint;
  const source = createHash("sha256");
  for (const path of [
    "../certify.md",
    "../orchestrate.md",
    "../report.ts",
    "../observe.ts",
    "../state.ts",
    "Qualify.ts",
    "Availability.ts",
    "LoadConfiguration.ts",
    "Marker.ts",
    "CheckMarker.ts",
  ]) {
    source
      .update(path)
      .update("\0")
      .update(yield* readTextFile(new URL(path, import.meta.url)));
  }
  report.fingerprints.source = source.digest("hex");
  const host = yield* platform();
  report.platform.os =
    host.os === "darwin" || host.os === "linux" || host.os === "win32" ? host.os : "unknown";
  report.platform.arch = host.arch === "arm64" || host.arch === "x64" ? host.arch : "unknown";
  const state: QualificationState = { configuration, report, marker: randomUUID() };
  yield* Qualification.set(state);
  yield* observeQualification(report);
  let failure: unknown;
  try {
    yield* joinQualification(report, () => content());
  } catch (error) {
    failure = error;
  }
  const final = finalizeReport(report);
  yield* writeTextFile(
    resolve(yield* cwd(), String(input.report)),
    JSON.stringify(final, null, 2) + "\n",
  );
  if (failure !== undefined) {
    throw failure;
  }
  if (state.failure !== undefined) {
    throw state.failure;
  }
  return "The capability report was written. Evidence is incomplete: native cleanup remains unverified. No durable-session certification was granted.";
}
