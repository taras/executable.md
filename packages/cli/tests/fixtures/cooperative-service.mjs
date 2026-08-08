import { createServer } from "node:http";

const [mode = "normal", nonce = "none"] = process.argv.slice(2);
const host = process.env.XMD_SERVICE_HOST;
const requestedPort = Number(process.env.XMD_SERVICE_PORT);
const token = process.env.XMD_SERVICE_TOKEN;

process.stderr.write(`service pid:${process.pid}\n`);

if (mode === "exit-before") {
  process.exit(17);
}

if (mode === "non-cooperative") {
  setInterval(() => {}, 1_000);
} else {
  process.stdout.write("service stdout before readiness\n");
  process.stderr.write("service stderr before readiness\n");

  const server = createServer((_request, response) => {
    process.stderr.write(`service request:${nonce}\n`);
    response.end(`service:${nonce}`);
    if (mode === "exit-on-request") {
      setTimeout(() => process.exit(19), 10);
    }
  });

  process.on("SIGTERM", () => {
    process.stderr.write(`service stopping:${nonce}\n`);
    server.close(() => process.exit(0));
  });

  server.listen(requestedPort, host, () => {
    const address = server.address();
    if (typeof address !== "object" || address === null) {
      process.exit(18);
    }

    const ready = {
      version: 1,
      token,
      hostname: host,
      port: address.port,
    };
    if (mode === "malformed") {
      process.stdout.write(`XMD_SERVICE_READY:{not-json}\n`);
      return;
    }
    if (mode === "non-object") {
      process.stdout.write(`XMD_SERVICE_READY:null\n`);
      return;
    }
    if (mode === "incompatible") {
      process.stdout.write(`XMD_SERVICE_READY:${JSON.stringify({ ...ready, version: 2 })}\n`);
      return;
    }
    if (mode === "forged") {
      process.stdout.write(
        `XMD_SERVICE_READY:${JSON.stringify({ ...ready, token: "forged-token" })}\n`,
      );
      return;
    }
    if (mode === "wrong-host") {
      process.stdout.write(
        `XMD_SERVICE_READY:${JSON.stringify({ ...ready, hostname: "0.0.0.0" })}\n`,
      );
      return;
    }
    if (mode === "extra-member") {
      process.stdout.write(`XMD_SERVICE_READY:${JSON.stringify({ ...ready, unsafe: token })}\n`);
      return;
    }
    if (mode === "partial-record") {
      process.stdout.write(`XMD_SERVICE_READY:${JSON.stringify(ready)}`);
      setTimeout(() => process.exit(20), 10);
    }
    if (mode === "delayed") {
      return;
    }

    const line = `XMD_SERVICE_READY:${JSON.stringify(ready)}\n`;
    process.stdout.write(line);
    process.stdout.write("service stdout after readiness\n");
    process.stderr.write("service stderr after readiness\n");

    if (mode === "unterminated-live-output") {
      process.stdout.write("unterminated-live-output");
      process.stderr.write("unterminated live output written\n");
    }

    if (mode === "duplicate") {
      setTimeout(() => process.stdout.write(line), 10);
    }
    if (mode === "exit-after") {
      setTimeout(() => process.exit(19), 10);
    }
  });
}
