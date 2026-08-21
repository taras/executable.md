/**
 * Tier WA — the broker, and what a lease is allowed to be.
 *
 * The one component that ever holds a credential value, and the one boundary
 * that must not let one out. Everything a provider gets is a lease: it says
 * whether the host proved an identity for one exact locator, and it can attach
 * itself to a command. There is no member on it that answers with a username or
 * a password, and this suite is where that is checked rather than assumed.
 *
 * Nothing here reads a developer's real credential. The invoking user is a
 * fixture home with a helper program in it, isolated from the machine's own
 * system configuration, and no assertion prints a credential-shaped value.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { scoped, type Operation } from "effection";
import { credentialRequest, denoCredentialBroker } from "../src/deno/composition/authentication.ts";
import type { CredentialLease } from "../src/deno/composition/authentication.ts";
import { useHomeWithoutAuthentication, useInvokingHome } from "./support/credential-home.ts";

/** The credentials this suite arranges. Never compared, only detected. */
const FIRST = { username: "broker-user-one", password: "broker-secret-one" } as const;
const SECOND = { username: "broker-user-two", password: "broker-secret-two" } as const;

/** Whether any credential this suite arranged appears in `text`. */
function carriesCredential(text: string): boolean {
  for (const entry of [FIRST, SECOND]) {
    if (text.includes(entry.password) || text.includes(entry.username)) {
      return true;
    }
  }
  return false;
}

/**
 * Which credential a lease speaks for, decided by the fixture rather than read.
 *
 * A lease has no member that answers with a value, so the only way to tell what
 * it holds is to look at the environment it hands a command. That is exactly
 * what this contract permits — the value reaches a subprocess and nothing else —
 * and the answer is reduced to a label so a failure prints one.
 */
function speaksFor(lease: CredentialLease): string {
  const attached = JSON.stringify(lease.attachment().environment);
  if (attached.includes(FIRST.password)) {
    return "first";
  }
  return attached.includes(SECOND.password) ? "second" : "none";
}

const HOST = "credential.invalid";

describe("workflow credential broker", () => {
  it("proves an identity for the exact locator its lease was minted for", function* () {
    const home = yield* useInvokingHome([{ host: HOST, path: "octo/one.git", ...FIRST }]);
    const broker = denoCredentialBroker(home.ambient);

    yield* scoped(function* () {
      const lease = yield* broker.lease({
        protocol: "https",
        host: HOST,
        path: "octo/one.git",
      });
      expect(lease.acquired).toBe(true);
      expect(speaksFor(lease)).toBe("first");
    });
  });

  it("acquires nothing for another repository on the same host", function* () {
    // The distinguishing case: one host, two paths, and an invoking user who
    // can prove an identity for one of them. A broker asked about less than the
    // whole locator would answer for both.
    const home = yield* useInvokingHome([{ host: HOST, path: "octo/one.git", ...FIRST }]);
    const broker = denoCredentialBroker(home.ambient);

    yield* scoped(function* () {
      const mine = yield* broker.lease({ protocol: "https", host: HOST, path: "octo/one.git" });
      const other = yield* broker.lease({ protocol: "https", host: HOST, path: "octo/two.git" });

      expect(mine.acquired).toBe(true);
      expect(speaksFor(mine)).toBe("first");
      // Not "the same credential for a different path" — no credential at all.
      expect(other.acquired).toBe(false);
      expect(speaksFor(other)).toBe("none");
      expect(other.attachment().configuration).toEqual([]);
    });
  });

  it("tells two repositories on one host apart, each by its own acquisition", function* () {
    const home = yield* useInvokingHome([
      { host: HOST, path: "octo/one.git", ...FIRST },
      { host: HOST, path: "octo/two.git", ...SECOND },
    ]);
    const broker = denoCredentialBroker(home.ambient);

    yield* scoped(function* () {
      const one = yield* broker.lease({ protocol: "https", host: HOST, path: "octo/one.git" });
      const two = yield* broker.lease({ protocol: "https", host: HOST, path: "octo/two.git" });
      // Two leases, two identities. Neither was reached by asking about the
      // host they share.
      expect(speaksFor(one)).toBe("first");
      expect(speaksFor(two)).toBe("second");
    });
  });

  /**
   * The invoking user configured no `useHttpPath`, and the helper is asked about
   * the repository anyway.
   *
   * Git withholds the path from every helper unless that setting is on, so a
   * host whose user never set it would answer about the server — one identity
   * for every repository on it. The broker forces the setting for its own
   * acquisition, which is why this fixture deliberately does not.
   */
  it("forces the path into the question the helper is asked", function* () {
    const home = yield* useInvokingHome([{ host: HOST, path: "octo/one.git", ...FIRST }]);
    const broker = denoCredentialBroker(home.ambient);

    yield* scoped(function* () {
      // The fixture's helper answers only for an exact `host|path` pair, so it
      // could not have answered at all if it had been asked about the host.
      const lease = yield* broker.lease({
        protocol: "https",
        host: HOST,
        path: "octo/one.git",
      });
      expect(lease.acquired).toBe(true);
      expect(speaksFor(lease)).toBe("first");
    });
  });

  it("refuses an answer that omits the repository it was asked about", function* () {
    // A helper that answers for the host alone. Adopting that would make one
    // acquisition the identity for every repository on the server.
    const home = yield* useInvokingHome([{ host: HOST, path: "", ...FIRST }]);
    const broker = denoCredentialBroker(home.ambient);

    yield* scoped(function* () {
      const lease = yield* broker.lease({
        protocol: "https",
        host: HOST,
        path: "octo/one.git",
      });
      expect(lease.acquired).toBe(false);
      expect(speaksFor(lease)).toBe("none");
    });
  });

  it("refuses an answer that is about somewhere else", function* () {
    // A helper is free to rewrite the request's own fields, and an answer about
    // another host has not authorized this one.
    const home = yield* useInvokingHome([{ host: "elsewhere.invalid", path: "", ...FIRST }]);
    const broker = denoCredentialBroker(home.ambient);

    yield* scoped(function* () {
      const lease = yield* broker.lease({ protocol: "https", host: HOST, path: "octo/one.git" });
      expect(lease.acquired).toBe(false);
      expect(speaksFor(lease)).toBe("none");
    });
  });

  it("acquires nothing when the invoking host holds nothing", function* () {
    const home = yield* useHomeWithoutAuthentication();
    const broker = denoCredentialBroker(home.ambient);

    yield* scoped(function* () {
      const lease = yield* broker.lease({ protocol: "https", host: HOST, path: "octo/one.git" });
      // A helper being configured is not authentication, and neither is one
      // that answered nothing. `acquired` is what the refusal vocabulary reads.
      expect(lease.acquired).toBe(false);
      expect(lease.attachment().configuration).toEqual([]);
      expect(lease.attachment().environment).toEqual({});
    });
  });

  it("puts no credential on a command line, only the shape of one", function* () {
    const home = yield* useInvokingHome([{ host: HOST, path: "octo/one.git", ...FIRST }]);
    const broker = denoCredentialBroker(home.ambient);

    yield* scoped(function* () {
      const lease = yield* broker.lease({
        protocol: "https",
        host: HOST,
        path: "octo/one.git",
      });
      const attached = lease.attachment();

      // What Git is told is one helper that names two variables. A command line
      // is observable to anything on the machine, so a value there would be a
      // credential published rather than borrowed.
      expect(carriesCredential(attached.configuration.join(" "))).toBe(false);
      expect(attached.configuration).toHaveLength(2);
      expect(attached.configuration[0]).toBe("-c");
      expect(String(attached.configuration[1]).startsWith("credential.helper=!")).toBe(true);
    });
  });

  it("installs a helper that answers `get` and refuses to store or erase", function* () {
    const home = yield* useInvokingHome([{ host: HOST, path: "octo/one.git", ...FIRST }]);
    const broker = denoCredentialBroker(home.ambient);

    yield* scoped(function* () {
      const lease = yield* broker.lease({
        protocol: "https",
        host: HOST,
        path: "octo/one.git",
      });
      const helper = String(lease.attachment().configuration[1]);

      // Acquisition-only in the strict sense: whatever Git decides to send
      // after a success or a rejection, there is no path through this helper
      // that writes, approves, rejects or forgets a credential.
      expect(helper).toContain('test "$1" = get || exit 0');
      expect(helper).not.toContain("store");
      expect(helper).not.toContain("erase");
      expect(helper).not.toContain("approve");
      expect(helper).not.toContain("reject");
    });
  });

  it("asks about the whole locator rather than about its host", function* () {
    expect(credentialRequest("https://example.invalid/owner/project.git")).toEqual({
      protocol: "https",
      host: "example.invalid",
      path: "owner/project.git",
    });
    expect(credentialRequest("http://127.0.0.1:9000/project.git")).toEqual({
      protocol: "http",
      host: "127.0.0.1:9000",
      path: "project.git",
    });
    // Nothing a broker of HTTP credentials answers for.
    expect(credentialRequest("ssh://git@example.invalid/owner/project.git")).toBeUndefined();
    expect(credentialRequest("/tmp/xmd-remote/remote.git")).toBeUndefined();
  });

  it("leaves nothing of a lease behind when its scope ends", function* () {
    const home = yield* useInvokingHome([{ host: HOST, path: "octo/one.git", ...FIRST }]);
    const opened: string[] = [];
    const released: string[] = [];
    const broker = denoCredentialBroker(home.ambient, {
      opened: (directory) => opened.push(directory),
      released: (directory) => released.push(directory),
    });

    let escaped: CredentialLease | undefined;
    yield* scoped(function* () {
      escaped = yield* broker.lease({ protocol: "https", host: HOST, path: "octo/one.git" });
      expect(escaped.acquired).toBe(true);
    });

    // The working directory the acquisition needed is gone with the scope that
    // opened it — one opened, the same one released.
    expect(opened).toHaveLength(1);
    expect(released).toEqual(opened);
  });
});

describe("workflow credential lease opacity", () => {
  it("has no member that answers with a credential", function* () {
    const home = yield* useInvokingHome([{ host: HOST, path: "octo/one.git", ...FIRST }]);
    const broker = denoCredentialBroker(home.ambient);

    yield* scoped(function* () {
      const lease = yield* broker.lease({
        protocol: "https",
        host: HOST,
        path: "octo/one.git",
      });

      // Two members, and neither is a value. A provider holding this cannot
      // read an identity out of it — the credential reaches Git through Git's
      // own protocol and never through XMD.
      expect(Object.keys(lease).sort()).toEqual(["acquired", "attachment"]);
      expect(carriesCredential(JSON.stringify(lease))).toBe(false);
      expect(carriesCredential(String(lease.acquired))).toBe(false);
      // Including everything a diagnostic would reach for.
      expect(carriesCredential(`${lease}`)).toBe(false);
      expect(carriesCredential(JSON.stringify(Object.entries(lease)))).toBe(false);
    });
  });

  it("carries a value no further than the subprocess environment", function* () {
    const home = yield* useInvokingHome([{ host: HOST, path: "octo/one.git", ...FIRST }]);
    const broker = denoCredentialBroker(home.ambient);

    yield* scoped(function* () {
      const attached = (yield* broker.lease({
        protocol: "https",
        host: HOST,
        path: "octo/one.git",
      })).attachment();

      // The environment of the command this lease speaks for is the only place
      // it materializes, and it is the same channel the SSH agent already
      // travels through.
      expect(Object.keys(attached.environment).sort()).toEqual([
        "XMD_GIT_CREDENTIAL_PASSWORD",
        "XMD_GIT_CREDENTIAL_USERNAME",
      ]);
      expect(carriesCredential(attached.configuration.join(" "))).toBe(false);
    });
  });
});
