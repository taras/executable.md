import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import {
  configurationSchema,
  reportSchema,
  initialReport,
  finalizeReport,
  recordConfigurationFailure,
  recordTurn,
  recordMarker,
  recordCancellation,
  recordCleanup,
} from "../../../examples/agent-certification/report.ts";

const config = configurationSchema.parse({
  command: "private-command",
  scenarios: [
    "authentication",
    "streaming",
    "completion",
    "continuity",
    "separation",
    "model",
    "effort",
    "reconnect",
    "cancellation",
    "cleanup",
    "resume",
  ],
  expected: ["completion"],
});
describe("closed agent qualification reports", () => {
  it("rejects unknown/missing report fields, version and private payloads", function* () {
    const report = initialReport(config);
    expect(reportSchema.safeParse({ ...report, version: 1 }).success).toBe(false);
    expect(
      reportSchema.safeParse({ ...report, capabilities: { ...report.capabilities, extra: {} } })
        .success,
    ).toBe(false);
    expect(
      reportSchema.safeParse({
        ...report,
        versions: { ...report.versions, agent: "/private/token" },
      }).success,
    ).toBe(false);
    expect(reportSchema.safeParse({ ...report, counts: undefined }).success).toBe(false);
    const privateValue = "private-sentinel-credential-marker-reply";
    recordConfigurationFailure(
      report,
      Object.assign(new Error(privateValue), {
        "executablemd.acp.configuration-failure": {
          reason: "selector-unavailable",
          setting: "model",
        },
      }),
    );
    expect(report.capabilities.model.outcome).toBe("unsupported");
    recordConfigurationFailure(report, {
      "executablemd.acp.configuration-failure": {
        reason: "configuration-mismatch",
        setting: "effort",
      },
    });
    expect(report.capabilities.effort.outcome).toBe("failure");
    recordMarker(report, "continuity", privateValue, privateValue, true);
    expect(JSON.stringify(finalizeReport(report))).not.toContain(privateValue);
    expect(JSON.stringify(report)).not.toContain(config.command);
  });
  it("refuses malformed observations and gives unusable Sessions failure precedence", function* () {
    for (const error of [
      null,
      {
        "executablemd.acp.configuration-failure": {
          reason: "selector-unavailable",
          setting: "model",
          extra: true,
        },
      },
      {
        sessionUnusable: true,
        "executablemd.acp.configuration-failure": {
          reason: "selector-unavailable",
          setting: "model",
        },
      },
    ]) {
      const report = initialReport({ ...config, model: "selected" });
      recordConfigurationFailure(report, error);
      expect(report.capabilities.model.outcome).toBe("failure");
    }
  });
  it("keeps unsupported, incomplete, omitted and unselected evidence distinct", function* () {
    const omitted = initialReport(config);
    expect(omitted.capabilities.model.reason).toBe("selection-not-requested");
    const selected = initialReport({ ...config, scenarios: ["completion"] });
    expect(selected.capabilities.model.reason).toBe("unselected");
    recordTurn(selected, { accepted: true, completed: true, deltas: 1 });
    expect(finalizeReport(selected).complete).toBe(false);
    expect(finalizeReport(selected).selectedCapabilitiesPassed).toBe(false);
    recordConfigurationFailure(omitted, {
      "executablemd.acp.configuration-failure": {
        reason: "selector-unavailable",
        setting: "effort",
      },
    });
    expect(omitted.capabilities.effort.outcome).toBe("unsupported");
  });
  it("withholds cancellation and durable certification for unverified native cleanup", function* () {
    const report = initialReport(config);
    recordCancellation(report, {
      requestedStop: true,
      activeAtStop: true,
      attributed: true,
      completed: false,
      ownerJoined: true,
      nativeCleanupVerified: false,
    });
    recordCleanup(report, true, false);
    expect(report.capabilities.cancellation.outcome).toBe("not_run");
    expect(report.capabilities.cancellation.reason).toBe("cleanup-unverified");
    expect(report.capabilities.cancellation.observations.attributed).toBe(true);
    expect(finalizeReport(report).durableSessionCertified).toBe(false);
    for (const observation of [
      {
        requestedStop: false,
        activeAtStop: true,
        attributed: false,
        completed: false,
        ownerJoined: true,
        nativeCleanupVerified: true,
      },
      {
        requestedStop: true,
        activeAtStop: false,
        attributed: false,
        completed: true,
        ownerJoined: true,
        nativeCleanupVerified: true,
      },
      {
        requestedStop: true,
        activeAtStop: true,
        attributed: false,
        completed: false,
        ownerJoined: true,
        nativeCleanupVerified: true,
      },
    ]) {
      recordCancellation(report, observation);
      expect(report.capabilities.cancellation.outcome).toBe("failure");
    }
    recordCancellation(report, {
      requestedStop: true,
      activeAtStop: true,
      attributed: true,
      completed: false,
      ownerJoined: true,
      nativeCleanupVerified: true,
    });
    expect(report.capabilities.cancellation.outcome).toBe("pass");
  });
  it("rejects unknown, repeated scenarios, credentials and empty commands", function* () {
    for (const value of [
      { ...config, token: "private" },
      { ...config, command: " " },
      { ...config, scenarios: ["completion", "completion"] },
      { ...config, scenarios: ["other"] },
    ]) {
      expect(configurationSchema.safeParse(value).success).toBe(false);
    }
  });
});
