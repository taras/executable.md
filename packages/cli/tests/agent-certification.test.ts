import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { runCli } from "@executablemd/test-support/launch";
import { readTextFile, writeTextFile } from "@effectionx/fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { withCertificationFixture } from "../../acp/tests/certification-fixture.ts";
import { reportSchema } from "../../../examples/agent-certification/report.ts";

const example = fileURLToPath(new URL("../../../examples/agent-certification/", import.meta.url));
describe(
  "local agent certification CLI journey",
  { sanitizeOps: false, sanitizeResources: false },
  () => {
    it("reuses two local configurations in certification and ordinary separate OS invocations", function* () {
      for (const mode of ["normal", "second-local-agent"]) {
        yield* withCertificationFixture(function* (f) {
          const config = join(f.dir, "local.json");
          const reportPath = join(f.dir, "report.json");
          yield* writeTextFile(
            config,
            JSON.stringify({
              command: f.command(mode),
              model: "selected",
              effort: "high",
              scenarios: [
                "authentication",
                "streaming",
                "separation",
                "model",
                "effort",
                "completion",
                "continuity",
                "cleanup",
                "reconnect",
                "cancellation",
                "resume",
              ],
              expected: ["completion"],
            }),
          );
          const result = yield* runCli(
            [
              "run",
              join(example, "certify.md"),
              "--include",
              join(example, "components"),
              "--props-config",
              config,
              "--props-report",
              reportPath,
              "--deny-all",
              "--raw",
            ],
            { cwd: f.dir, env: { HOME: f.home }, timeout: 120_000 },
          ).join();
          expect([result.code, result.stderr]).toEqual([0, ""]);
          for (const name of [
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
          ]) {
            expect(result.stdout).toContain(`${name} |`);
          }
          expect(result.stdout).not.toContain(f.dir);
          const report = reportSchema.parse(JSON.parse(yield* readTextFile(reportPath)));
          expect(report.complete).toBe(false);
          expect(report.durableSessionCertified).toBe(false);
          expect(report.counts.prompts).toBe(6);
          expect(report.capabilities.cleanup.reason).toBe("cleanup-unverified");
          const methods = yield* f.methods();
          expect(methods.filter((method) => method === "session/prompt").length).toBe(6);
          expect(methods.filter((method) => method === "session/cancel").length).toBe(1);
          expect(
            methods.filter((method) => method === "session/load").length,
          ).toBeGreaterThanOrEqual(2);
          for (const name of [
            "authentication",
            "streaming",
            "completion",
            "continuity",
            "separation",
            "model",
            "effort",
            "reconnect",
            "resume",
          ] satisfies (keyof typeof report.capabilities)[]) {
            expect(report.capabilities[name].outcome).toBe("pass");
          }
          expect(report.capabilities.cancellation.observations.attributed).toBe(true);
          const turns = (yield* f.calls()).filter((call) => call.method === "session/prompt");
          expect(turns.map((turn) => turn.kind)).toEqual([
            "seed",
            "recall",
            "recall",
            "recall",
            "cancel",
            "recall",
          ]);
          expect(turns[0].sessionId).toBe(turns[1].sessionId);
          expect(turns[0].sessionId).not.toBe(turns[2].sessionId);
          expect(turns[0].sessionId).toBe(turns[3].sessionId);
          expect(turns[0].sessionId).toBe(turns[5].sessionId);
          expect(turns[0].sessionId).not.toBe(turns[4].sessionId);

          const marker = randomUUID();
          for (const prompt of ["seed:" + marker, "recall"]) {
            const ordinary = yield* runCli(
              [
                "run",
                join(example, "orchestrate.md"),
                "--include",
                join(example, "components"),
                "--props-config",
                config,
                "--props-prompt",
                prompt,
                "--deny-all",
                "--raw",
              ],
              { cwd: f.dir, env: { HOME: f.home }, timeout: 120_000 },
            ).join();
            expect(ordinary.code).toBe(0);
            expect(ordinary.stdout.trim()).toBe(prompt === "recall" ? marker : "READY");
          }
          expect((yield* f.methods()).filter((method) => method === "session/prompt").length).toBe(
            8,
          );
        });
      }
    });

    for (const mode of ["no-acceptance", "lost"]) {
      it(`runs the actual document with ${mode} without fabricating capability evidence`, function* () {
        yield* withCertificationFixture(function* (f) {
          const config = join(f.dir, "negative.json");
          const target = join(f.dir, "negative-report.json");
          yield* writeTextFile(
            config,
            JSON.stringify({
              command: f.command(mode),
              scenarios: [
                "authentication",
                "streaming",
                "completion",
                "continuity",
                "separation",
                "reconnect",
                "cancellation",
                "cleanup",
                "resume",
              ],
              expected: ["completion"],
            }),
          );
          const result = yield* runCli(
            [
              "run",
              join(example, "certify.md"),
              "--include",
              join(example, "components"),
              "--props-config",
              config,
              "--props-report",
              target,
              "--deny-all",
              "--raw",
            ],
            { cwd: f.dir, env: { HOME: f.home }, timeout: 120_000 },
          ).join();
          expect(result.code).toBe(1);
          const report = reportSchema.parse(JSON.parse(yield* readTextFile(target)));
          expect(report.selectedCapabilitiesPassed).toBe(false);
          expect(report.durableSessionCertified).toBe(false);
          const calls = yield* f.calls();
          const turns = calls.filter((call) => call.method === "session/prompt");
          if (mode === "no-acceptance") {
            expect(turns.length).toBe(1);
            expect(calls.filter((call) => call.method === "session/load").length).toBe(0);
            expect(report.capabilities.authentication.outcome).not.toBe("pass");
            expect(report.capabilities.resume.outcome).toBe("not_run");
          } else {
            expect(turns.map((turn) => turn.kind)).toEqual([
              "seed",
              "recall",
              "recall",
              "recall",
              "cancel",
              "recall",
            ]);
            expect(report.capabilities.completion.outcome).toBe("pass");
            expect(report.capabilities.continuity.outcome).toBe("failure");
            expect(report.capabilities.cancellation.observations.attributed).toBe(true);
            expect(calls.filter((call) => call.method === "session/cancel").length).toBe(1);
          }
          for (const [name] of Object.entries(report.capabilities)) {
            expect(result.stderr).toContain(`${name} |`);
          }
          expect(result.stderr).not.toContain(f.dir);
        });
      });
    }
    it("writes a precise non-pass for a bad local command", function* () {
      yield* withCertificationFixture(function* (f) {
        const config = join(f.dir, "bad.json");
        const report = join(f.dir, "bad-report.json");
        yield* writeTextFile(
          config,
          JSON.stringify({
            command: "xmd-certainly-missing-certification-agent",
            scenarios: ["authentication", "cleanup"],
            expected: ["authentication"],
          }),
        );
        const result = yield* runCli(
          [
            "run",
            join(example, "certify.md"),
            "--include",
            join(example, "components"),
            "--props-config",
            config,
            "--props-report",
            report,
            "--deny-all",
            "--raw",
          ],
          { cwd: f.dir, env: { HOME: f.home }, timeout: 120_000 },
        ).join();
        expect(result.code).toBe(1);
        expect(result.stderr).toContain("authentication |");
        const outcome = reportSchema.parse(JSON.parse(yield* readTextFile(report)));
        expect(outcome.capabilities.authentication.outcome).toBe("failure");
        expect(outcome.capabilities.authentication.reason).toBe("agent-unavailable");
        expect(JSON.stringify(outcome)).not.toContain("xmd-certainly-missing");
        expect(yield* f.methods()).toEqual([]);
      });
    });
  },
);
