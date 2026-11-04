import { action, each, ensure, resource, useScope } from "effection";
import type { Operation } from "effection";
import { createServer } from "node:http";
import { fromReadable } from "@effectionx/node/stream";

export interface ProtectedInputObserver {
  readonly url: string;
  readonly answers: number;
  readonly commands: number;
  readonly exact: boolean;
  readonly latestExact: boolean;
  contains(text: string): boolean;
}

export function useProtectedInputObserver(): Operation<ProtectedInputObserver> {
  return resource(function* (provide) {
    const answers: string[] = [];
    const commands: string[] = [];
    const scope = yield* useScope();
    const server = createServer((incoming, outgoing) => {
      scope.run(function* () {
        const decoder = new TextDecoder();
        let text = "";
        for (const chunk of yield* each(fromReadable(incoming))) {
          text += decoder.decode(chunk, { stream: true });
          yield* each.next();
        }
        text += decoder.decode();
        if (incoming.url === "/answer") {
          answers.push(text);
        }
        if (incoming.url === "/process") {
          commands.push(text);
        }
        outgoing.writeHead(200, { connection: "close" });
        outgoing.end("ok");
      });
    });
    yield* ensure(function* () {
      server.closeAllConnections();
      yield* action<void>((resolve) => {
        server.close(() => resolve());
        return () => {};
      });
    });
    yield* action<void>((resolve, reject) => {
      const failed = (error: Error) => reject(error);
      server.on("error", failed);
      server.listen(0, "127.0.0.1", () => resolve());
      return () => server.off("error", failed);
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Missing private test IPC listener.");
    }
    yield* provide({
      url: `http://127.0.0.1:${address.port}`,
      get answers() {
        return answers.length;
      },
      get commands() {
        return commands.length;
      },
      get exact() {
        return commands.every(
          (value, index) => value === answers[Math.min(index, answers.length - 1)],
        );
      },
      get latestExact() {
        return commands.every(
          (value, index) => value === answers[answers.length - commands.length + index],
        );
      },
      contains(text) {
        return answers.some((value) => text.includes(value));
      },
    });
  });
}

export function protectedInputCommand(binding: string, url: string): string {
  const program = `const http = require("node:http"); const request = http.request(${JSON.stringify(url + "/process")}, {method:"POST"}, (response) => {response.resume();}); request.on("error", () => {process.exitCode=1;}); request.end(process.env.npm_config_otp);`;
  return `npm_config_otp={${binding}} node -e '${program}'`;
}
