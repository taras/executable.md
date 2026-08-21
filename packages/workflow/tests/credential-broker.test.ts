/**
 * Tier WA — the broker child, and what a lease is allowed to be.
 *
 * The credential lives in a process of its own now. The provider holds a
 * capability and an endpoint; the broker child holds whatever the invoking
 * user's Git could prove for one exact repository; the shim Git runs is the only
 * program that writes a credential anywhere. So the questions here are about the
 * boundary rather than about a value: what a lease carries, what the broker
 * refuses, and what is left when a lease ends.
 *
 * Nothing here reads a developer's real credential. The invoking user is a
 * fixture home with a helper program in it, isolated from the machine's own
 * system configuration, and no assertion prints a credential-shaped value.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { scoped, until, type Operation } from "effection";
import { readFile, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import process from "node:process";
import { credentialRequest } from "../src/deno/composition/authentication.ts";
import { denoCredentialBroker } from "../src/deno/composition/broker/host.ts";
import type { CredentialLease } from "../src/deno/composition/broker/host.ts";
import { internalModes } from "../src/deno/composition/broker/main.ts";
import { CAPABILITY_VARIABLE, ENDPOINT_VARIABLE } from "../src/deno/composition/broker/protocol.ts";
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

const HOST = "credential.invalid";

function brokerFor(ambient: Record<string, string>, observe = {}) {
  return denoCredentialBroker({ ambient, observe, internal: internalModes() });
}

/**
 * Ask a lease's shim the way Git asks it, and label what came back.
 *
 * The only way to learn what a lease speaks for is to be Git: run the shim it
 * installed, in the environment it attached, with a credential request on
 * standard input. That is the contract working rather than a way around it — and
 * the answer is reduced to a label, so a failure prints one.
 */
function ask(
  lease: CredentialLease,
  operation: string,
  request: Readonly<Record<string, string>>,
): string {
  const attached = lease.attachment();
  const named = attached.configuration.find((entry: string) =>
    entry.startsWith("credential.helper="),
  );
  const helper = String(named ?? "").replace("credential.helper=", "");
  if (helper === "") {
    return "none";
  }
  const lines = Object.entries(request).map(([key, value]) => `${key}=${value}`);
  const outcome = spawnSync(helper, [operation], {
    input: `${lines.join("\n")}\n\n`,
    env: {
      ...(process.env.PATH === undefined ? {} : { PATH: process.env.PATH }),
      ...attached.environment,
    },
    encoding: "utf8",
  });
  const answered = typeof outcome.stdout === "string" ? outcome.stdout : "";
  if (answered.includes(FIRST.password)) {
    return "first";
  }
  return answered.includes(SECOND.password) ? "second" : "none";
}

const ONE = { protocol: "https", host: HOST, path: "octo/one.git" } as const;
const TWO = { protocol: "https", host: HOST, path: "octo/two.git" } as const;

describe("workflow credential broker", () => {
  it("proves an identity for the exact locator its lease was minted for", function* () {
    const home = yield* useInvokingHome([{ host: HOST, path: ONE.path, ...FIRST }]);

    yield* scoped(function* () {
      const lease = yield* brokerFor(home.ambient).lease(ONE);
      expect(lease.acquired).toBe(true);
      expect(ask(lease, "get", ONE)).toBe("first");
    });
  });

  it("acquires nothing for another repository on the same host", function* () {
    const home = yield* useInvokingHome([{ host: HOST, path: ONE.path, ...FIRST }]);

    yield* scoped(function* () {
      const other = yield* brokerFor(home.ambient).lease(TWO);
      // Not "the same credential for a different path" — no credential at all.
      expect(other.acquired).toBe(false);
      expect(ask(other, "get", TWO)).toBe("none");
    });
  });

  it("tells two repositories on one host apart, each by its own lease", function* () {
    const home = yield* useInvokingHome([
      { host: HOST, path: ONE.path, ...FIRST },
      { host: HOST, path: TWO.path, ...SECOND },
    ]);

    yield* scoped(function* () {
      const broker = brokerFor(home.ambient);
      const one = yield* broker.lease(ONE);
      const two = yield* broker.lease(TWO);
      expect(ask(one, "get", ONE)).toBe("first");
      expect(ask(two, "get", TWO)).toBe("second");
    });
  });

  it("forces the path into the question the helper is asked", function* () {
    // The fixture deliberately configures no `useHttpPath`, and its helper
    // answers only for an exact host and path — so it could not have answered
    // at all if the broker had asked about the server.
    const home = yield* useInvokingHome([{ host: HOST, path: ONE.path, ...FIRST }]);

    yield* scoped(function* () {
      expect((yield* brokerFor(home.ambient).lease(ONE)).acquired).toBe(true);
    });
  });

  it("refuses an answer that omits the repository it was asked about", function* () {
    const home = yield* useInvokingHome([{ host: HOST, path: "", ...FIRST }]);

    yield* scoped(function* () {
      expect((yield* brokerFor(home.ambient).lease(ONE)).acquired).toBe(false);
    });
  });

  it("acquires nothing when the invoking host holds nothing", function* () {
    const home = yield* useHomeWithoutAuthentication();

    yield* scoped(function* () {
      const lease = yield* brokerFor(home.ambient).lease(ONE);
      expect(lease.acquired).toBe(false);
      expect(ask(lease, "get", ONE)).toBe("none");
    });
  });
});

describe("workflow credential broker refusals", () => {
  it("answers nothing for a transport that ended up somewhere else", function* () {
    const home = yield* useInvokingHome([{ host: HOST, path: ONE.path, ...FIRST }]);

    yield* scoped(function* () {
      const lease = yield* brokerFor(home.ambient).lease(ONE);
      expect(lease.acquired).toBe(true);

      // A redirect is Git asking about wherever it arrived. The shim restates
      // that, and a broker leased for somewhere else answers nothing — so a
      // redirected transport fails closed rather than carrying this identity.
      expect(ask(lease, "get", { ...ONE, host: "elsewhere.invalid" })).toBe("none");
      expect(ask(lease, "get", { ...ONE, protocol: "http" })).toBe("none");
      expect(ask(lease, "get", { ...ONE, host: `${HOST}:8443` })).toBe("none");
      expect(ask(lease, "get", { ...ONE, path: TWO.path })).toBe("none");
      expect(ask(lease, "get", { protocol: "https", host: HOST, path: "" })).toBe("none");
      // And the one it was minted for still answers.
      expect(ask(lease, "get", ONE)).toBe("first");
    });
  });

  it("serves `get` and nothing else", function* () {
    const home = yield* useInvokingHome([{ host: HOST, path: ONE.path, ...FIRST }]);

    yield* scoped(function* () {
      const lease = yield* brokerFor(home.ambient).lease(ONE);
      // Git sends these after a success and after a rejection. Neither writes,
      // forgets, approves or rejects anything: there is no such path.
      expect(ask(lease, "store", ONE)).toBe("none");
      expect(ask(lease, "erase", ONE)).toBe("none");
      expect(ask(lease, "approve", ONE)).toBe("none");
      expect(ask(lease, "reject", ONE)).toBe("none");
    });
  });

  it("answers nothing to a capability that is not this lease's", function* () {
    const home = yield* useInvokingHome([{ host: HOST, path: ONE.path, ...FIRST }]);

    yield* scoped(function* () {
      const lease = yield* brokerFor(home.ambient).lease(ONE);
      const attached = lease.attachment();
      const helper = String(
        attached.configuration.find((entry: string) => entry.startsWith("credential.helper=")),
      ).replace("credential.helper=", "");

      // The endpoint is reachable and the question is well formed. Only the
      // capability is wrong, and it is checked before a credential byte is
      // emitted — so an endpoint somebody found answers nothing.
      const outcome = spawnSync(helper, ["get"], {
        input: `protocol=${ONE.protocol}\nhost=${ONE.host}\npath=${ONE.path}\n\n`,
        env: {
          ...(process.env.PATH === undefined ? {} : { PATH: process.env.PATH }),
          [ENDPOINT_VARIABLE]: String(attached.environment[ENDPOINT_VARIABLE]),
          [CAPABILITY_VARIABLE]: "0".repeat(64),
        },
        encoding: "utf8",
      });
      expect(carriesCredential(String(outcome.stdout ?? ""))).toBe(false);
    });
  });

  it("answers nothing once the lease that owned it has ended", function* () {
    const home = yield* useInvokingHome([{ host: HOST, path: ONE.path, ...FIRST }]);
    let escaped: CredentialLease | undefined;

    yield* scoped(function* () {
      escaped = yield* brokerFor(home.ambient).lease(ONE);
      expect(escaped.acquired).toBe(true);
    });

    // The lease was invalidated before its endpoint was removed, so a shim that
    // survived its invocation speaks for nothing rather than racing teardown.
    expect(escaped?.acquired).toBe(false);
    expect(escaped?.attachment().configuration).toEqual([]);
    expect(ask(escaped as CredentialLease, "get", ONE)).toBe("none");
  });
});

describe("workflow credential lease opacity", () => {
  it("has no member that answers with a credential", function* () {
    const home = yield* useInvokingHome([{ host: HOST, path: ONE.path, ...FIRST }]);

    yield* scoped(function* () {
      const lease = yield* brokerFor(home.ambient).lease(ONE);
      // Two members, and neither is a value. The credential is in another
      // process entirely — there is nothing here for one to answer with.
      expect(Object.keys(lease).sort()).toEqual(["acquired", "attachment"]);
      expect(carriesCredential(JSON.stringify(lease))).toBe(false);
      expect(carriesCredential(`${lease}`)).toBe(false);
    });
  });

  it("attaches an endpoint and a capability, and no credential at all", function* () {
    const home = yield* useInvokingHome([{ host: HOST, path: ONE.path, ...FIRST }]);

    yield* scoped(function* () {
      const attached = (yield* brokerFor(home.ambient).lease(ONE)).attachment();

      // What the command carries is where to ask and what to ask with. The
      // provider process never receives a username or a password, so neither is
      // here to leak into a command's environment.
      expect(Object.keys(attached.environment).sort()).toEqual([
        CAPABILITY_VARIABLE,
        ENDPOINT_VARIABLE,
      ]);
      expect(carriesCredential(JSON.stringify(attached.environment))).toBe(false);
      // And a command line names a program, never a secret.
      expect(carriesCredential(attached.configuration.join(" "))).toBe(false);
      expect(attached.configuration).toHaveLength(4);
      expect(attached.configuration).toContain("credential.useHttpPath=true");
      expect(
        attached.configuration.some((entry: string) => entry.startsWith("credential.helper=/")),
      ).toBe(true);
    });
  });

  it("installs a shim only this user can run, holding no credential", function* () {
    const home = yield* useInvokingHome([{ host: HOST, path: ONE.path, ...FIRST }]);

    yield* scoped(function* () {
      const attached = (yield* brokerFor(home.ambient).lease(ONE)).attachment();
      const helper = String(
        attached.configuration.find((entry: string) => entry.startsWith("credential.helper=")),
      ).replace("credential.helper=", "");

      const mode = (yield* until(stat(helper))).mode & 0o777;
      expect(mode & 0o077).toBe(0);
      // The file is a launcher for this host's own internal mode. Neither the
      // credential nor the capability is in it — the capability travels in the
      // environment, which a process listing does not show.
      const written = yield* until(readFile(helper, "utf8"));
      expect(carriesCredential(written)).toBe(false);
      expect(written).not.toContain(String(attached.environment[CAPABILITY_VARIABLE]));
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
    expect(credentialRequest("ssh://git@example.invalid/owner/project.git")).toBeUndefined();
    expect(credentialRequest("/tmp/xmd-remote/remote.git")).toBeUndefined();
  });

  it("leaves no endpoint, shim or broker behind when its scope ends", function* () {
    const home = yield* useInvokingHome([{ host: HOST, path: ONE.path, ...FIRST }]);
    const opened: string[] = [];
    const released: string[] = [];
    let helper = "";

    yield* scoped(function* () {
      const lease = yield* brokerFor(home.ambient, {
        opened: (directory: string) => opened.push(directory),
        released: (directory: string) => released.push(directory),
      }).lease(ONE);
      helper = String(
        lease
          .attachment()
          .configuration.find((entry: string) => entry.startsWith("credential.helper=")),
      ).replace("credential.helper=", "");
      expect(lease.acquired).toBe(true);
    });

    expect(opened).toHaveLength(1);
    expect(released).toEqual(opened);
    // The launcher and the endpoint go together, and only after the broker they
    // addressed has been signalled and awaited.
    expect(
      yield* until(
        stat(helper)
          .then(() => true)
          .catch(() => false),
      ),
    ).toBe(false);
  });
});
