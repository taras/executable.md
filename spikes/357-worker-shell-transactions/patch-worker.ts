const packagePath = new URL(
  "./node_modules/@effectionx/worker/package.json",
  import.meta.url,
);
const workerPath = new URL(
  "./node_modules/@effectionx/worker/dist/worker.js",
  import.meta.url,
);
const metadata: unknown = JSON.parse(Deno.readTextFileSync(packagePath));
if (
  typeof metadata !== "object" || metadata === null ||
  !("version" in metadata) || metadata.version !== "0.5.4"
) {
  throw new Error(
    "the Worker termination patch requires @effectionx/worker 0.5.4",
  );
}

const original = `            worker.postMessage({ type: "close" });
            if (!outcomeSettled) {`;
const replacement = `            worker.postMessage({ type: "close" });
            worker.terminate();
            if (!outcomeSettled) {
                rejectOutcome(new Error("worker terminated"));
            }
            if (!outcomeSettled) {`;
const source = Deno.readTextFileSync(workerPath);
if (source.includes(replacement)) {
  console.log("@effectionx/worker force-termination patch already applied");
} else if (source.includes(original)) {
  Deno.writeTextFileSync(workerPath, source.replace(original, replacement));
  console.log("patched @effectionx/worker 0.5.4 for forceful scope shutdown");
} else {
  throw new Error(
    "@effectionx/worker shutdown source no longer matches the proven patch",
  );
}
