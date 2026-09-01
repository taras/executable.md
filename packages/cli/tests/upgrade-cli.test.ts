/**
 * Tier UC — the `xmd upgrade` command line.
 *
 * Shelling out is what makes these evidence: exit status, stdout and stderr are
 * observed the way a caller sees them, and the entrypoint under test is the one
 * belonging to whichever runtime this suite is running under. So the same file
 * proves the Deno-source refusal in the Deno job, the npm/Node refusal in the
 * Node job, and the Bun refusal in the Bun job — three assemblies, each stated
 * by the entrypoint that knows, each read back from a real process.
 *
 * What separates a grammar refusal from a policy refusal is which sentence
 * appears. Every answer the packaged document gives ends by saying that nothing
 * was read and nothing changed; a command line the CLI settles never reaches
 * that document, so that sentence is absent. Each case below asserts both
 * halves, because "the right message appeared" does not by itself say that the
 * policy, the host assembly and the release lookup were never entered.
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { cliRuntime, runCli } from "@executablemd/test-support/launch";
import { ensureDir, exists, readTextFile, rm, writeTextFile } from "@effectionx/fs";
import { ensure, scoped } from "effection";
import type { Operation } from "effection";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A directory this case owns, so a trace never lands in the checkout. */
function* useDirectory<T>(body: (dir: string) => Operation<T>): Operation<T> {
  const dir = join(tmpdir(), `xmd-uc-${randomUUID()}`);
  yield* ensureDir(dir);
  return yield* scoped(function* () {
    yield* ensure(() => rm(dir, { recursive: true, force: true }));
    return yield* body(dir);
  });
}

/**
 * The clause every answer from the packaged policy carries.
 *
 * A command line the CLI settles never reaches that document, so this phrase is
 * absent from a grammar refusal — which is what lets each case below say the
 * policy, the host assembly and the release lookup were never entered, rather
 * than only that some message appeared.
 */
const POLICY_ANSWER = "No release was read";

/**
 * The approved answer this runtime's entrypoint gives, whole.
 *
 * Asserted complete rather than by a fragment: this is the sentence somebody
 * meets when the command cannot help them, and its wording is the contract.
 */
function expectedRefusal(): string {
  switch (cliRuntime()) {
    case "deno":
      return (
        "This xmd is running through Deno or a repository checkout. Update the " +
        "jsr:@executablemd/cli version, or update the checkout and run deno task setup. " +
        "No release was read, and no binary was changed."
      );
    case "node":
      return (
        "npm manages this xmd installation. Run npm install -g @executablemd/cli@latest, " +
        "or replace latest with an exact package version. No release was read, and the binary " +
        "was not changed."
      );
    case "bun":
      return (
        "Bun manages this xmd installation. Run bun add -g @executablemd/cli@latest, or " +
        "replace latest with an exact package version. No release was read, and the binary was " +
        "not changed."
      );
  }
}

/** Everything a run configures that this command deliberately does not offer. */
const EXECUTION_OPTIONS = [
  "--include",
  "--verbose",
  "--raw",
  "--timeout",
  "--agent-provider",
  "--default-agent",
  "--approve-all",
  "--deny-all",
  "--secret-detection",
  "--eval",
  "--pattern",
  "--props",
  "--output",
  "--session",
];

describe("Tier UC — xmd upgrade", { sanitizeOps: false, sanitizeResources: false }, () => {
  it("UC1: program help lists the command with its settled description", function* () {
    const { stdout } = yield* runCli(["--help"]).expect();

    expect(stdout).toContain(
      "Upgrade the standalone xmd binary to the latest stable or a specified release.",
    );
  });

  it("UC2: command help explains the whole command and performs none of it", function* () {
    const { code, stdout, stderr } = yield* runCli(["upgrade", "--help"]).join();

    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("Usage: xmd upgrade [OPTIONS] [tag]");
    // The default, the two ways to name a release, and each switch.
    expect(stdout).toContain("installs the latest published stable release");
    expect(stdout).toContain("xmd upgrade v1.3.0-rc.1 --allow-prerelease");
    expect(stdout).toContain("--status");
    expect(stdout).toContain("--allow-downgrade");
    expect(stdout).toContain("--allow-prerelease");
    // The matrix, in the words the product settled on rather than "Unix".
    expect(stdout).toContain("Only a compiled xmd on macOS or Linux can replace itself");
    expect(stdout).toContain("Windows: use the installer or a release asset");
    expect(stdout).toContain("npm or Node                update with npm");
    expect(stdout).toContain("Bun                        update with Bun");
    expect(stdout).toContain(
      "Deno or repository source  update the package version or the checkout",
    );
    // What an install actually does before it replaces anything.
    expect(stdout).toContain("published SHA-256 checksum");
    expect(stdout).toContain("replaces the binary that ran");
    expect(stdout).toContain("one atomic rename");
    // Help is not the command: the policy that would refuse this very host
    // never ran, so its answer is nowhere in this output.
    expect(stdout).not.toContain(POLICY_ANSWER);
    expect(stdout).not.toContain(expectedRefusal());
  });

  it("UC3: command help offers nothing a run configures", function* () {
    const { stdout } = yield* runCli(["upgrade", "--help"]).expect();

    for (const option of EXECUTION_OPTIONS) {
      expect({ option, listed: stdout.includes(option) }).toEqual({ option, listed: false });
    }
  });

  it("UC4: this entrypoint refuses with its own remedy, and reads nothing first", function* () {
    const { code, stdout, stderr } = yield* runCli(["upgrade"]).join();

    expect(code).toBe(1);
    expect(stderr).toContain(expectedRefusal());
    // The document is the output, so a refused host still renders its heading —
    // and nothing else. It claims no status and no installation, because
    // neither began.
    expect(stdout.trim()).toBe("# Upgrade XMD");
  });

  it("UC5: --status refuses on this entrypoint too, before any release lookup", function* () {
    const { code, stderr } = yield* runCli(["upgrade", "--status"]).join();

    expect(code).toBe(1);
    expect(stderr).toContain(expectedRefusal());
  });

  it("UC6: a command line this command does not define never reaches the policy", function* () {
    const refusals: [string[], string][] = [
      [
        ["upgrade", "--nope"],
        // The one approved message this revision changes, and only by the option
        // the same revision added: a refusal that enumerates what the command
        // accepts and omits `--journal` is a false sentence.
        "xmd upgrade does not recognize --nope. It accepts one optional release tag and these " +
          "options: --status, --allow-downgrade, --allow-prerelease, --journal.",
      ],
      [["upgrade", "--timeout", "5s"], "xmd upgrade does not recognize --timeout."],
      [["upgrade", "--version"], "xmd upgrade does not recognize --version."],
      [
        ["upgrade", "v1.2.3", "v1.2.4"],
        "xmd upgrade accepts at most one release tag. v1.2.4 is an extra argument.",
      ],
      [
        ["upgrade", "--props-name", "Ada"],
        "unrecognized option for xmd upgrade: --props-name — document properties are exclusive",
      ],
      [
        ["upgrade", "--eval", "# hello"],
        "unrecognized option for xmd upgrade: --eval — inline documents are exclusive to xmd run",
      ],
    ];

    for (const [args, message] of refusals) {
      const { code, stdout, stderr } = yield* runCli(args).join();
      // A command line the CLI settles never reaches the document, so nothing
      // is rendered at all — not even the heading.
      expect({ args, code, stdout }).toEqual({ args, code: 1, stdout: "" });
      expect(stderr).toContain(message);
      // The refusal is the command line's. Nothing built a host assembly, read
      // the packaged document or asked GitHub anything.
      expect(stderr).not.toContain(POLICY_ANSWER);
    }
  });

  it("UC7: a value written on a switch is refused rather than read as its default", function* () {
    // configliere resolves `--status=false` to the field's default, which is
    // `false` — so the spelling that looks like "turn it off" and the spelling
    // that means "turn it on" would both run an install. There is one way to
    // write each switch, and this names it.
    for (const written of ["--status=false", "--status=true", "--allow-downgrade=1"]) {
      const { code, stderr } = yield* runCli(["upgrade", written]).join();
      const option = written.split("=")[0] ?? "";
      expect({ written, code }).toEqual({ written, code: 1 });
      expect(stderr).toContain(
        `${option} does not take a value. Use ${option} by itself or omit it.`,
      );
      expect(stderr).not.toContain(POLICY_ANSWER);
    }
  });

  it("UC8: xmd workflow keeps its own --status", function* () {
    // Two commands define an option of the same name and different shape: a
    // switch here, a run-state value there. A parse that let one answer for the
    // other would either refuse a valid workflow query or read a workflow state
    // as consent.
    const { code, stderr } = yield* runCli(["workflow", "list", "--status=nonsense"]).join();

    expect(code).toBe(1);
    // Whatever this host says about `xmd workflow`, it is not this command's
    // grammar: `--status=nonsense` was never read as a value written on
    // upgrade's switch.
    expect(stderr).not.toContain("xmd upgrade");
    expect(stderr).not.toContain("does not take a value");

    if (cliRuntime() === "deno") {
      // Only the Deno entrypoint carries the command, so only there does the
      // value reach the parser that defines it and get judged as a run state.
      expect(stderr).toContain("unrecognized value for --status: nonsense");
      expect(stderr).toContain("running, suspended, interrupted, completed, failed, cancelled");
      return;
    }
    // Node and Bun refuse the command before any of its options are read.
    expect(stderr).toContain("only through the Deno entrypoint or compiled xmd binary");
  });

  it("UC9: --journal writes one new trace and changes nothing a reader sees", function* () {
    yield* useDirectory(function* (dir) {
      const plain = yield* runCli(["upgrade", "--status"], { cwd: dir }).join();

      const traced = join(dir, "trace.jsonl");
      const withTrace = yield* runCli(["upgrade", "--status", "--journal", traced], {
        cwd: dir,
      }).join();

      // Byte-identical terminal output, and the same status: the trace is
      // evidence about a run, not part of it.
      expect({ stdout: withTrace.stdout, stderr: withTrace.stderr, code: withTrace.code }).toEqual({
        stdout: plain.stdout,
        stderr: plain.stderr,
        code: plain.code,
      });
      // A refused run still keeps the trace it produced.
      expect(yield* exists(traced)).toBe(true);
      expect((yield* readTextFile(traced)).length).toBeGreaterThan(0);
    });
  });

  it("UC10: -j is the same option, and both refuse a path that exists", function* () {
    yield* useDirectory(function* (dir) {
      const short = join(dir, "short.jsonl");
      yield* runCli(["upgrade", "--status", "-j", short], { cwd: dir }).join();
      expect(yield* exists(short)).toBe(true);

      // The path must not exist: a second run over the same name refuses rather
      // than appending to or replacing somebody's file.
      const again = yield* runCli(["upgrade", "--status", "-j", short], { cwd: dir }).join();
      expect(again.code).toBe(1);
      expect(again.stderr).toContain("already exists");
      // Refused before the document ran, so nothing was rendered.
      expect(again.stdout).toBe("");

      const taken = join(dir, "taken.txt");
      yield* writeTextFile(taken, "someone else's file\n");
      const clash = yield* runCli(["upgrade", "--status", "--journal", taken], { cwd: dir }).join();
      expect(clash.code).toBe(1);
      expect(yield* readTextFile(taken)).toBe("someone else's file\n");
    });
  });

  it("UC11: a journal option with no path is refused rather than ignored", function* () {
    for (const args of [
      ["upgrade", "--journal"],
      ["upgrade", "-j"],
      ["upgrade", "--journal", "--status"],
      ["upgrade", "--journal="],
    ]) {
      const { code, stdout, stderr } = yield* runCli(args).join();
      expect({ args, code, stdout }).toEqual({ args, code: 1, stdout: "" });
      expect(stderr).toContain("needs a path");
      expect(stderr).not.toContain(POLICY_ANSWER);
    }
  });

  it("UC12: no Upgrade phase is reachable from an ordinary document", function* () {
    // The four phases are declared to one execution of the exact packaged
    // document. They are not registered anywhere a user-authored document can
    // reach, which is what keeps binary replacement out of `xmd run`.
    const catalog = yield* runCli(["syntax"]).expect();
    expect(catalog.stdout).not.toContain("Upgrade.");

    yield* useDirectory(function* (dir) {
      yield* writeTextFile(
        join(dir, "attack.md"),
        '# Try it\n\n<Upgrade.Replace candidate="anything" as="r" />\n',
      );
      const { code, stderr } = yield* runCli(["run", "attack.md"], { cwd: dir }).join();

      expect(code).toBe(1);
      // Unresolved, rather than resolved to something that replaces a binary:
      // the ordinary run profile searches the component path and finds nothing.
      expect(stderr).toContain("Cannot resolve component: Upgrade.Replace");
    });
  });
});
