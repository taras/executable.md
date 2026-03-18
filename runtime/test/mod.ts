/**
 * @module
 * Test helpers for executable markdown runtime.
 *
 * Composable stubs for runtime context APIs:
 * - `useStubFs(files)` — in-memory filesystem
 * - `useEchoExec()` — simple echo-based exec
 * - `useFailingExec(exitCode, stderr)` — always-failing exec
 */

export { useStubFs, useEchoExec, useFailingExec } from "./stubs.ts";
