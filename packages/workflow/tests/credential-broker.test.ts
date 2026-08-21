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
import { spawn, spawnSync } from "node:child_process";
import { connect } from "node:net";
import { Buffer } from "node:buffer";
import process from "node:process";
import { credentialRequest } from "../src/deno/composition/authentication.ts";
import {
  denoCredentialBroker,
  endpointFor,
  TEARDOWN,
} from "../src/deno/composition/broker/host.ts";
import type { CredentialLease } from "../src/deno/composition/broker/host.ts";
import {
  BROKER_MODE,
  internalModes,
  INTERNAL_MODE,
  SHIM_MODE,
} from "../src/deno/composition/broker/main.ts";
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
      expect(Object.keys(lease).sort()).toEqual(["acquired", "attachment", "rejected"]);
      expect(typeof lease.rejected).toBe("function");
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

describe("workflow credential broker exclusivity", () => {
  /** Ask through the shim without waiting, so two can be in flight at once. */
  function asking(lease: CredentialLease, request: Readonly<Record<string, string>>) {
    const attached = lease.attachment();
    const helper = String(
      attached.configuration.find((entry: string) => entry.startsWith("credential.helper=")),
    ).replace("credential.helper=", "");
    const lines = Object.entries(request).map(([key, value]) => `${key}=${value}`);
    return new Promise<string>((resolve) => {
      const child = spawn(helper, ["get"], {
        env: {
          ...(process.env.PATH === undefined ? {} : { PATH: process.env.PATH }),
          ...attached.environment,
        },
        stdio: ["pipe", "pipe", "ignore"],
      });
      let answered = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        answered += chunk;
      });
      child.on("close", () => resolve(answered.includes(FIRST.password) ? "first" : "none"));
      child.stdin.end(`${lines.join("\n")}\n\n`);
    });
  }

  it("answers one caller at a time and refuses a second while it is busy", function* () {
    const home = yield* useInvokingHome([{ host: HOST, path: ONE.path, ...FIRST }]);

    yield* scoped(function* () {
      const lease = yield* brokerFor(home.ambient).lease(ONE);
      // A lease belongs to one live invocation, whose commands are sequential.
      // Two at once is not that invocation, so at most one is answered.
      const both = yield* until(
        Promise.all([asking(lease, ONE), asking(lease, ONE), asking(lease, ONE)]),
      );
      expect(both.filter((answer) => answer === "first").length).toBeLessThan(3);
      expect(both.filter((answer) => answer === "first").length).toBeGreaterThan(0);
    });
  });

  it("answers a reconciliation's commands one after another", function* () {
    const home = yield* useInvokingHome([{ host: HOST, path: ONE.path, ...FIRST }]);

    yield* scoped(function* () {
      const lease = yield* brokerFor(home.ambient).lease(ONE);
      // An observation, then the mutation it decided. Both are this lease's,
      // and both are answered — exclusivity is about overlap, not about count.
      expect(ask(lease, "get", ONE)).toBe("first");
      expect(ask(lease, "get", ONE)).toBe("first");
      expect(ask(lease, "get", ONE)).toBe("first");
    });
  });
});

describe("workflow credential broker rejection", () => {
  it("turns Git's erase into a signal, forwards nothing and says nothing", function* () {
    const home = yield* useInvokingHome([{ host: HOST, path: ONE.path, ...FIRST }]);

    yield* scoped(function* () {
      const lease = yield* brokerFor(home.ambient).lease(ONE);
      expect(yield* lease.rejected()).toBe(false);

      // Git sends `erase` when the transport refused what the helper gave.
      expect(ask(lease, "erase", ONE)).toBe("none");
      // Nothing was printed, and nothing was forgotten — the credential still
      // answers. What changed is what this invocation now knows.
      expect(ask(lease, "get", ONE)).toBe("first");
      // Asked, not waited for: the answer is about the command that has already
      // finished, so there is nothing to time.
      expect(yield* lease.rejected()).toBe(true);
    });
  });

  it("keeps a rejection to the lease it happened on", function* () {
    const home = yield* useInvokingHome([{ host: HOST, path: ONE.path, ...FIRST }]);

    yield* scoped(function* () {
      const broker = brokerFor(home.ambient);
      const rejected = yield* broker.lease(ONE);
      ask(rejected, "erase", ONE);
      expect(yield* rejected.rejected()).toBe(true);

      // Another invocation's lease knows nothing about it. A rejection is a
      // live fact about one attempt, not a state anything retains.
      const fresh = yield* broker.lease(ONE);
      expect(yield* fresh.rejected()).toBe(false);
      expect(fresh.acquired).toBe(true);
    });
  });

  it("ignores an erase that is not about this lease's repository", function* () {
    const home = yield* useInvokingHome([{ host: HOST, path: ONE.path, ...FIRST }]);

    yield* scoped(function* () {
      const lease = yield* brokerFor(home.ambient).lease(ONE);
      ask(lease, "erase", { ...ONE, host: "elsewhere.invalid" });
      expect(yield* lease.rejected()).toBe(false);
    });
  });
});

describe("workflow credential broker teardown", () => {
  it("invalidates, terminates, closes, awaits, then removes", function* () {
    const home = yield* useInvokingHome([{ host: HOST, path: ONE.path, ...FIRST }]);
    const steps: string[] = [];

    yield* scoped(function* () {
      const lease = yield* brokerFor(home.ambient, {
        step: (name: string) => steps.push(name),
      }).lease(ONE);
      expect(lease.acquired).toBe(true);
      expect(steps).toEqual([]);
    });

    // The order is the contract. A lease invalidated after its endpoint went
    // away, or an endpoint removed while a broker still answered on it, would
    // be these same steps in an unsafe sequence.
    expect(steps).toEqual([
      TEARDOWN.invalidated,
      TEARDOWN.terminated,
      TEARDOWN.closed,
      TEARDOWN.awaited,
      TEARDOWN.removed,
    ]);
  });

  it("survives a broker that never came up, without pretending it did", function* () {
    const home = yield* useInvokingHome([{ host: HOST, path: ONE.path, ...FIRST }]);
    const steps: string[] = [];

    yield* scoped(function* () {
      // A broker mode that is not there at all. Infrastructure failing is a
      // host that can prove nothing, which the caller already has a word for —
      // never a completion and never a raise from inside acquisition.
      const lease = yield* denoCredentialBroker({
        ambient: home.ambient,
        observe: { step: (name: string) => steps.push(name) },
        internal: {
          broker: () => ({ command: "xmd-no-such-broker-program", args: [] }),
          shim: () => ({ command: "xmd-no-such-shim-program", args: [] }),
        },
      }).lease(ONE);

      expect(lease.acquired).toBe(false);
      expect(yield* lease.rejected()).toBe(false);
      expect(lease.attachment().configuration).toEqual([]);
    });
    expect(steps).toContain(TEARDOWN.removed);
  });

  it("answers nothing when its protocol is spoken badly", function* () {
    const home = yield* useInvokingHome([{ host: HOST, path: ONE.path, ...FIRST }]);

    yield* scoped(function* () {
      const lease = yield* brokerFor(home.ambient).lease(ONE);
      const attached = lease.attachment();
      const endpoint = String(attached.environment[ENDPOINT_VARIABLE]);

      // Not a question at all. A broker that guessed at one would be answering
      // something nobody asked.
      const answered = yield* until(
        new Promise<string>((resolve) => {
          const socket = connect(endpoint);
          let buffered = "";
          socket.on("error", () => resolve(""));
          socket.on("data", (chunk: Buffer) => {
            buffered += chunk.toString("utf8");
          });
          socket.on("close", () => resolve(buffered));
          socket.on("connect", () => socket.end("this is not a question\n"));
        }),
      );
      expect(carriesCredential(answered)).toBe(false);
    });
  });
});

describe("workflow credential broker addressing", () => {
  it("puts no endpoint and no capability on any command line", function* () {
    const home = yield* useInvokingHome([{ host: HOST, path: ONE.path, ...FIRST }]);

    yield* scoped(function* () {
      const lease = yield* brokerFor(home.ambient).lease(ONE);
      const attached = lease.attachment();
      const endpoint = String(attached.environment[ENDPOINT_VARIABLE]);
      const capability = String(attached.environment[CAPABILITY_VARIABLE]);

      // The broker is started with the arguments its mode needs and nothing
      // else. A capability on an argument vector is a secret every process
      // listing shows to anything running as this user, and an endpoint there
      // is an address nobody had to be told.
      const started = internalModes("/usr/local/bin/xmd").broker();
      expect(started.args.join(" ")).not.toContain(capability);
      expect(started.args.join(" ")).not.toContain(endpoint);

      // Nor on the command line Git is given, which names one program.
      expect(attached.configuration.join(" ")).not.toContain(capability);
      expect(attached.configuration.join(" ")).not.toContain(endpoint);
    });
  });

  it("says one deterministic thing about itself, and says it once", function* () {
    const home = yield* useInvokingHome([{ host: HOST, path: ONE.path, ...FIRST }]);
    const announced: string[] = [];

    yield* scoped(function* () {
      // The broker's own record, read the way the parent reads it. It is one
      // line: a parent that had to wait to see whether another was still coming
      // would be deciding by timer about a process it is already connected to.
      const lease = yield* denoCredentialBroker({
        ambient: home.ambient,
        internal: {
          broker: () => internalModes().broker(),
          shim: () => internalModes().shim(),
        },
        observe: { step: (name: string) => announced.push(name) },
      }).lease(ONE);
      expect(lease.acquired).toBe(true);
    });
    expect(announced[0]).toBe(TEARDOWN.invalidated);
  });
});

describe("workflow credential broker on Windows", () => {
  it("addresses a random invocation-local named pipe", function* () {
    // Proved on whatever host this suite runs on, because the platform is a
    // parameter: a pipe has no directory to hide in, so its protection is a
    // name nobody can guess plus the capability check every answer passes.
    const one = endpointFor("/ignored", "win32");
    const two = endpointFor("/ignored", "win32");

    expect(one.startsWith("\\\\.\\pipe\\xmd-credential-")).toBe(true);
    expect(one).not.toBe(two);
    // Long enough that it is not guessed, and nothing in it names this run.
    expect(one.length).toBeGreaterThan(40);

    // No all-user access option is stated anywhere: the name is created as it
    // is given, and nothing widens it.
    expect(one).not.toContain("Everyone");
    expect(one).not.toContain("*");

    // And a Unix host still hides in its directory rather than in its name.
    expect(endpointFor("/tmp/xmd-lease", "linux")).toBe("/tmp/xmd-lease/endpoint");
  });
});

describe("workflow credential internal modes", () => {
  it("assembles the same two modes for source and for a compiled binary", function* () {
    const module = "file:///project/packages/workflow/src/deno/composition/broker/main.ts";
    const source = internalModes("/usr/local/bin/deno", module);
    const compiled = internalModes("/usr/local/bin/xmd", module);

    // Running from source the executable is Deno, so the module has to be named
    // to it; compiled, the executable is this host and carries its own modes.
    expect(source.broker().command).toBe("/usr/local/bin/deno");
    expect(source.broker().args).toEqual([
      "run",
      "--allow-all",
      "/project/packages/workflow/src/deno/composition/broker/main.ts",
      INTERNAL_MODE,
      BROKER_MODE,
    ]);
    expect(compiled.broker()).toEqual({
      command: "/usr/local/bin/xmd",
      args: [INTERNAL_MODE, BROKER_MODE],
    });

    // Both assemble the same pair, and the shim differs from the broker only in
    // which mode it selects.
    expect(source.shim().args.at(-1)).toBe(SHIM_MODE);
    expect(compiled.shim().args.at(-1)).toBe(SHIM_MODE);
    expect(source.shim().args.at(-2)).toBe(INTERNAL_MODE);
    expect(compiled.shim().args.at(-2)).toBe(INTERNAL_MODE);
  });
});
