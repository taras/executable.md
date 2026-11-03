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
              scenarios: [
                "authentication",
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
            { cwd: f.dir, env: { HOME: f.home } },
          ).join();
          expect([result.code, result.stderr]).toEqual([0, ""]);
          expect(result.stdout).toContain(
            "Evidence is incomplete: native cleanup remains unverified.",
          );
          expect(result.stdout).not.toContain(f.dir);
          const report = reportSchema.parse(JSON.parse(yield* readTextFile(reportPath)));
          expect(report.complete).toBe(false);
          expect(report.durableSessionCertified).toBe(false);
          expect(report.counts.prompts).toBe(0);
          expect(report.capabilities.cleanup.reason).toBe("cleanup-unverified");
          // The preliminary release ends admission: no connection for turn 1,
          // replacement for reconnect or later invocation is constructed.
          const methods = yield* f.methods();
          expect(methods).toEqual(["initialize"]);
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
              { cwd: f.dir, env: { HOME: f.home } },
            ).join();
            expect(ordinary.code).toBe(0);
            expect(ordinary.stdout.trim()).toBe(prompt === "recall" ? marker : "READY");
          }
          expect((yield* f.methods()).filter((method) => method === "session/prompt").length).toBe(
            2,
          );
        });
      }
    });
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
          { cwd: f.dir, env: { HOME: f.home } },
        ).join();
        expect(result.code).toBe(1);
        expect(result.stderr).toContain("xmd-certainly-missing-certification-agent");
        const outcome = reportSchema.parse(JSON.parse(yield* readTextFile(report)));
        expect(outcome.capabilities.authentication.outcome).toBe("failure");
        expect(outcome.capabilities.authentication.reason).toBe("agent-unavailable");
        expect(JSON.stringify(outcome)).not.toContain("xmd-certainly-missing");
        expect(yield* f.methods()).toEqual([]);
      });
    });
  },
);
