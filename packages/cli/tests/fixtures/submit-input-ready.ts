import process from "node:process";

const emit = process.stdin.emit.bind(process.stdin);
process.stdin.emit = (...args: Parameters<typeof process.stdin.emit>) => {
  const emitted = emit(...args);
  if (args[0] === "data") {
    process.stderr.write("xmd-submit-input-owned\n");
  }
  return emitted;
};
const entry = process.env["XMD_TEST_SUBMIT_ENTRY"];
if (entry === undefined) {
  throw new Error("The subprocess fixture requires its supplied CLI entrypoint.");
}
await import(entry);
