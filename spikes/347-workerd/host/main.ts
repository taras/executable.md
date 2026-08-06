import { main, suspend, until } from "effection";
import { materialize } from "./materialize.ts";
import { useWorkerd } from "./supervise.ts";

interface Cli {
  command: "serve" | "do";
  target: string;
  stateDir: string;
  identity: string | undefined;
  backends: boolean;
}

function usage(): never {
  console.error(
    [
      "usage:",
      "  proof serve --state-dir <dir> [--backends]",
      '  proof do "<path-with-query>" --state-dir <dir> [--identity <name>] [--backends]',
      "",
      'ops are HTTP paths on the bundled Worker, e.g. "/increment",',
      '"/fs/write?path=/a.txt&body=hi", "/exec?backend=worker-shell&source=echo hi"',
    ].join("\n"),
  );
  Deno.exit(2);
}

function parseArgv(argv: string[]): Cli {
  const [command, ...rest] = argv;
  if (command !== "serve" && command !== "do") {
    usage();
  }
  let target = "";
  let stateDir = "";
  let identity;
  let backends = false;
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (argument === "--state-dir") {
      index += 1;
      stateDir = rest[index] ?? "";
    } else if (argument === "--identity") {
      index += 1;
      identity = rest[index];
    } else if (argument === "--backends") {
      backends = true;
    } else if (!argument.startsWith("--") && target === "") {
      target = argument;
    } else {
      usage();
    }
  }
  if (stateDir === "") {
    usage();
  }
  if (command === "do" && target === "") {
    usage();
  }
  return { command, target, stateDir, identity, backends };
}

main(function* () {
  const cli = parseArgv(Deno.args);
  const materialized = yield* materialize();
  const server = yield* useWorkerd({
    workerdPath: materialized.workerdPath,
    configPath: cli.backends
      ? materialized.backendsConfigPath
      : materialized.configPath,
    stateDir: cli.stateDir,
  });

  if (cli.command === "serve") {
    console.log(
      JSON.stringify({ ready: true, port: server.port, workerdPid: server.pid }),
    );
    yield* suspend();
    return;
  }

  const separator = cli.target.includes("?") ? "&" : "?";
  const query = cli.identity === undefined
    ? cli.target
    : `${cli.target}${separator}identity=${encodeURIComponent(cli.identity)}`;
  const response = yield* until(
    fetch(`http://127.0.0.1:${server.port}${query}`),
  );
  const text = yield* until(response.text());
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`non-JSON response (${response.status}): ${text.slice(0, 300)}`);
  }
  console.log(JSON.stringify({ status: response.status, body }));
});
