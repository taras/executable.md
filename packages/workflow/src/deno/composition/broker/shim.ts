/**
 * The helper Git runs, and the only process here that writes a credential.
 *
 * Git hands it a credential request on standard input and reads Git's own
 * credential format back. Between those two ends it asks the broker — over this
 * lease's private endpoint, presenting this lease's capability — and it restates
 * what Git asked about rather than what the lease was minted for. That is the
 * whole of the redirect defence: if Git ended up somewhere else, the broker is
 * told so and answers nothing.
 *
 * It acquires nothing itself. There is no path through this program that reaches
 * a keychain, a helper or a configuration file, so a shim reached by anything
 * other than this lease's Git is a program that can only be refused.
 *
 * `store` and `erase` are read and discarded. Git sends them after a success or
 * a rejection, and the answer to both is silence: nothing here writes, forgets,
 * approves or rejects a stored credential.
 */

import { Buffer } from "node:buffer";
import { connect } from "node:net";
import process from "node:process";
import {
  CAPABILITY_VARIABLE,
  decodeAnswer,
  encodeLine,
  ENDPOINT_VARIABLE,
  GET,
  REJECTED,
} from "./protocol.ts";

/** The fields Git wrote, as far as they can be read. */
function readRequest(input: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const line of input.split("\n")) {
    const separator = line.indexOf("=");
    if (separator > 0) {
      fields.set(line.slice(0, separator), line.slice(separator + 1));
    }
  }
  return fields;
}

/** Read everything on standard input, which Git closes when it has finished. */
function readAll(): Promise<string> {
  return new Promise((resolve) => {
    let buffered = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      buffered += chunk;
    });
    process.stdin.on("end", () => resolve(buffered));
    process.stdin.on("error", () => resolve(buffered));
  });
}

/**
 * Answer one credential request, or answer nothing.
 *
 * Nothing is a complete answer in Git's protocol: a helper that prints no
 * username and no password has declined, and Git goes on to whatever is next —
 * which, with terminal prompting off and no other helper configured, is a
 * refusal this run can state.
 */
export async function serveCredentialShim(argv: readonly string[]): Promise<void> {
  const operation = argv[0] ?? "";
  const input = await readAll();
  if (operation !== GET && operation !== "erase") {
    // `store`, `approve` and anything else are read to the end and answered
    // with silence. Nothing is written, forwarded or remembered.
    return;
  }

  const endpoint = process.env[ENDPOINT_VARIABLE];
  const capability = process.env[CAPABILITY_VARIABLE];
  if (endpoint === undefined || capability === undefined) {
    return;
  }

  const asked = readRequest(input);
  const question = encodeLine({
    capability,
    // `erase` becomes a rejection signal rather than an erasure. Git sends it
    // when the transport refused what this helper gave, which is the only way
    // this run can tell "the host proved nothing" from "the host proved
    // something the remote would not accept". Both are unavailability.
    operation: operation === GET ? GET : REJECTED,
    protocol: asked.get("protocol") ?? "",
    // Git writes the port into `host` when there is one, which is what makes an
    // explicit port part of what the broker compares.
    host: asked.get("host") ?? "",
    path: asked.get("path") ?? "",
  });

  const answer = await new Promise<string>((resolve) => {
    const socket = connect(endpoint);
    let buffered = "";
    const finish = () => resolve(buffered);
    socket.on("error", () => resolve(""));
    socket.on("data", (chunk: Buffer) => {
      buffered += chunk.toString("utf8");
    });
    socket.on("end", finish);
    socket.on("close", finish);
    socket.on("connect", () => socket.write(question));
  });

  if (operation !== GET) {
    // A rejection produces no output at all, whatever came back.
    return;
  }
  const { username, password } = decodeAnswer(answer.split("\n")[0] ?? "");
  if (username === undefined || password === undefined) {
    return;
  }
  process.stdout.write(`username=${username}\npassword=${password}\n`);
}
