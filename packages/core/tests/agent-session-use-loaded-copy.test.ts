/**
 * Tier SU — a use minted by a second loaded copy of this module (issue #828).
 *
 * A document can be run by a host that loaded `@executablemd/core` once and by
 * one that has two copies in its graph — a bundled plugin, a differently
 * specified import, a vendored build. Both copies answer to the same name, so a
 * value one of them issued arrives at the other looking exactly like something
 * it made itself.
 *
 * It is not. The claim a use carries is a registered symbol, deliberately
 * shared: any copy can see that a value presents itself as configured. The
 * authority is a private class field, and a private field belongs to the class
 * that declared it — so the copy that did not mint this value cannot read what
 * it says, and must not run the conversation as though it had no settings.
 *
 * That is what this file establishes, with an actual second copy rather than a
 * description of one. The copy is built by bundling the module, because
 * importing the same source path again resolves to the module this test already
 * holds and shares every class with it.
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, resource, until } from "effection";
import type { Operation } from "effection";
import { exec } from "@effectionx/process";
import { rm } from "@effectionx/fs";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import process from "node:process";
import { fileURLToPath } from "node:url";
import type { Session, SessionConfiguration } from "../src/agent/agent-api.ts";
import { claimsConfiguration, configurationOf, isSessionUse } from "../src/agent/session-use.ts";

const REPOSITORY = fileURLToPath(new URL("../../..", import.meta.url));
const SESSION_USE_MODULE = fileURLToPath(new URL("../src/agent/session-use.ts", import.meta.url));

const SESSION: Session = { sessionKey: "xmd:v1:review", cwd: "/repo" };

/** Whether `value` carries what every session a provider issues carries. */
function isSession(value: object): value is Session {
  return (
    typeof Reflect.get(value, "sessionKey") === "string" &&
    typeof Reflect.get(value, "cwd") === "string"
  );
}

/** The half of the other copy's surface this suite mints values through. */
interface LoadedCopy {
  issueSessionUse(
    session: Session,
    configuration: SessionConfiguration,
    generation: object,
  ): Session;
}

/**
 * The other copy's surface, read rather than assumed.
 *
 * What comes back from a dynamic import is a value, and reading it as this
 * module's own shape is this side's decision — the same way core parses what a
 * provider installation delivered rather than believing it.
 */
function loadedCopy(value: unknown): LoadedCopy | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const issueSessionUse = Reflect.get(value, "issueSessionUse");
  if (typeof issueSessionUse !== "function") {
    return undefined;
  }
  return {
    issueSessionUse: (session, configuration, generation) => {
      const issued = Reflect.apply(issueSessionUse, value, [session, configuration, generation]);
      if (typeof issued !== "object" || issued === null) {
        throw new Error("the bundled copy issued no session use");
      }
      // Read as a session the way any routed value is: by its members, not by
      // where it came from. Narrowed rather than copied — a copy of a use is a
      // different thing entirely, and the whole question here is what the other
      // copy's own object does.
      if (!isSession(issued)) {
        throw new Error("the bundled copy issued a value that is not a session");
      }
      return issued;
    },
  };
}

/** `session-use.ts`, bundled and evaluated as its own module. */
function useSeparateCopy(): Operation<LoadedCopy> {
  return resource(function* (provide) {
    const directory = yield* until(mkdtemp(join(tmpdir(), "su-loaded-copy-")));
    yield* ensure(() => rm(directory, { recursive: true, force: true }));
    const bundle = join(directory, "session-use.js");

    // `process.execPath` under Deno is the deno binary, so the driver stays
    // typed against node:process rather than a runtime global.
    const built = yield* exec(process.execPath, {
      arguments: [
        "bundle",
        "--frozen",
        "--node-modules-dir=none",
        SESSION_USE_MODULE,
        "--output",
        bundle,
      ],
      cwd: REPOSITORY,
    }).join();
    if (built.code !== 0) {
      throw new Error(`could not bundle the session-use module:\n${built.stdout}${built.stderr}`);
    }

    const copy = loadedCopy(yield* until(import(`file://${bundle}`)));
    if (copy === undefined) {
      throw new Error("the bundled copy does not expose issueSessionUse()");
    }
    yield* provide(copy);
  });
}

describe("Tier SU — a use from another loaded copy", () => {
  it("SU7: it is seen as a claim, is not authentic here, and answers nothing", function* () {
    const copy = yield* useSeparateCopy();
    // Minted entirely by the other copy: its class, its private field, its
    // frozen configuration.
    const foreign = copy.issueSessionUse(SESSION, { model: "gpt-5.4", effort: "high" }, {});

    // Visible, because the claim is a registered symbol and is meant to be.
    expect(claimsConfiguration(foreign)).toBe(true);
    // And not this copy's to act on, because the authority is not.
    expect(isSessionUse(foreign)).toBe(false);
    // The failure this refusal exists to prevent is the quiet one: reading it
    // as an ordinary session would run that conversation under no settings at
    // all, and nothing would say so.
    let refused = "";
    try {
      configurationOf(foreign);
    } catch (error) {
      refused = error instanceof Error ? error.message : String(error);
    }
    expect(refused).toContain("not a configured session this build issued");
  });
});
