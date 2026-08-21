/**
 * A separate process that takes a session lease and then waits to be killed.
 *
 * The crash case cannot be simulated in-process: the point of an advisory lock
 * is that the kernel releases it when the holder dies, and nothing in the
 * surviving process observes that death. So this is a real child, and the test
 * really kills it.
 *
 * It lives in the repository rather than in a temporary directory because it
 * imports workspace packages, which resolve only inside the project.
 */
import { main, suspend } from "effection";
import { installDenoSessionLease, SessionLease } from "@executablemd/runtime";

const [root, key] = Deno.args;

await main(function* () {
  yield* installDenoSessionLease(root!);
  const outcome = yield* SessionLease.operations.acquire(key!);
  // The test waits for this line, so contention is measured against a lock
  // that exists rather than against a race with process startup.
  console.log(`lease:${outcome}`);
  yield* suspend();
});
