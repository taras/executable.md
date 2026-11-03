import { content } from "@executablemd/core";
import type { Json, PropsSchema } from "@executablemd/core";
import { readTextFile, writeTextFile } from "@effectionx/fs";
import { cwd, platform } from "@executablemd/runtime";
import { randomUUID, createHash } from "node:crypto";
import { resolve } from "node:path";
import { configurationSchema, initialReport, finalizeReport } from "../report.ts";
import { Qualification } from "../state.ts";
import type { QualificationState } from "../state.ts";

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
    "RunSequence.ts",
    "ResumeStage.ts",
    "ResumeProps.ts",
    "../stage-runner.ts",
    "../stages/initial.md",
    "../stages/reconnect.md",
    "../stages/cancel.md",
    "../stages/resume.md",
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
  const id = randomUUID();
  const state: QualificationState = {
    configuration,
    report,
    marker: randomUUID(),
    names: { a: `a-${id}`, b: `b-${id}`, c: `c-${id}` },
    seedAccepted: false,
    turn: { accepted: false, completed: false },
  };
  yield* Qualification.set(state);

  let failure: unknown;
  try {
    yield* content();
  } catch (error) {
    failure = error;
  }
  if (
    failure !== undefined ||
    state.failure !== undefined ||
    Object.values(state.report.capabilities).some(
      (row) => row.selected && row.outcome === "failure",
    )
  ) {
    state.report.exitState = "failed";
  }
  const final = finalizeReport(state.report);
  yield* writeTextFile(
    resolve(yield* cwd(), String(input.report)),
    JSON.stringify(final, null, 2) + "\n",
  );
  const rows = Object.entries(final.capabilities).map(
    ([name, row]) =>
      `${name} | selected=${row.selected} expected=${row.expected} | ${row.outcome} | ${row.reason}`,
  );
  const matrix =
    rows.join("\n") +
    `\nPrompts=${final.counts.prompts} cancellations=${final.counts.cancellationRequests} complete=${final.complete} selectedPass=${final.selectedCapabilitiesPassed} durable=${final.durableSessionCertified}`;
  if (final.exitState === "failed") {
    throw new Error(matrix);
  }
  return matrix;
}
