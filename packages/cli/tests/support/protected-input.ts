import { fileURLToPath } from "node:url";

const core = fileURLToPath(new URL("../../../core/api.ts", import.meta.url));
const engine = fileURLToPath(new URL("../../../core/mod.ts", import.meta.url));
const effection = import.meta.resolve("effection");

export function protectedInputPlugin(url: string, markedOnly = false): string {
  return `import { Plugin } from ${JSON.stringify(core)};
import { Elicitation } from ${JSON.stringify(engine)};
import { until } from ${JSON.stringify(effection)};
export default Plugin({ name: "protected-test-input", *install() {
  yield* Elicitation.around({ *elicit([request], next) {
    ${markedOnly ? `if (request.schema.properties?.code?.writeOnly !== true) { return yield* next(request); }` : ""}
    const value = String(Math.floor(100000 + Math.random() * 900000));
    yield* until(fetch(${JSON.stringify(url + "/answer")}, { method: "POST", body: value }));
    return request.schema.properties?.public === undefined ? { code: value } : { code: value, public: "useful" };
  }});
}});`;
}

export function protectedInputChild(url: string): string {
  return `const http = require("node:http");
const request = http.request(${JSON.stringify(url + "/process")}, { method: "POST" }, (response) => {
  response.resume();
  response.on("end", () => { process.stdout.write("process accepted input\\n"); });
});
request.on("error", () => { process.exitCode = 1; });
request.end(process.env.npm_config_otp);
`;
}
