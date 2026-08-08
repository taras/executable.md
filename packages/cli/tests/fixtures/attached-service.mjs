import { createServer, get } from "node:http";

const [mode = "normal", nonce = "none"] = process.argv.slice(2);
const host = process.env.XMD_SERVICE_HOST;
const requestedPort = Number(process.env.XMD_SERVICE_PORT);
const token = process.env.XMD_SERVICE_TOKEN;

process.stderr.write(`service pid:${process.pid}\n`);

if (mode === "exit-before") {
  process.exit(17);
}

if (mode === "not-handshake-compatible") {
  setInterval(() => {}, 1_000);
} else {
  process.stdout.write("service stdout before handshake\n");
  process.stderr.write("service stderr before handshake\n");

  const server = createServer((request, response) => {
    process.stderr.write(`service request:${nonce}\n`);

    if (mode === "ping-pong") {
      const requestUrl = new URL(request.url ?? "/", `http://${host}`);
      const peerHostname = requestUrl.searchParams.get("peerHostname");
      const peerPort = Number(requestUrl.searchParams.get("peerPort"));
      const origin = requestUrl.searchParams.get("origin");

      if (peerHostname && Number.isInteger(peerPort) && peerPort > 0 && origin) {
        const peerRequest = get(
          {
            hostname: peerHostname,
            port: peerPort,
            path: `/?origin=${encodeURIComponent(origin)}`,
          },
          (peerResponse) => {
            let peerBody = "";
            peerResponse.setEncoding("utf8");
            peerResponse.on("data", (chunk) => {
              peerBody += chunk;
            });
            peerResponse.on("end", () => response.end(`${nonce}→${peerBody}`));
          },
        );
        peerRequest.on("error", (error) => {
          response.statusCode = 502;
          response.end(`peer request failed: ${error.message}`);
        });
        return;
      }

      if (origin) {
        response.end(`${nonce}→${origin}`);
        return;
      }

      response.statusCode = 400;
      response.end("missing ping-pong peer");
      return;
    }

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
    process.stderr.write(`service endpoint:${nonce}:${host}:${address.port}\n`);
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
    process.stdout.write("service stdout after handshake\n");
    process.stderr.write("service stderr after handshake\n");

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
