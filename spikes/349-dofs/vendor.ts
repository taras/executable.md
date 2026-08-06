import { main } from "effection";
import { exec } from "@effectionx/process";

const dofsDir = new URL("./vendor/dofs/", import.meta.url).pathname;
const shimDir = new URL("./vendor/computerd-shim/", import.meta.url).pathname;

main(function* () {
  yield* exec("npm", {
    arguments: ["install", "--no-audit", "--no-fund"],
    cwd: dofsDir,
  }).expect();
  yield* exec("npx", {
    arguments: ["tsc", "-p", "tsconfig.build.json"],
    cwd: dofsDir,
  }).expect();
  console.log("vendored dofs built to vendor/dofs/dist");
  yield* exec("npm", {
    arguments: ["install", "--no-audit", "--no-fund"],
    cwd: shimDir,
  }).expect();
  yield* exec("npx", {
    arguments: ["tsc", "-p", "tsconfig.json"],
    cwd: shimDir,
  }).expect();
  console.log("vendored shim built to vendor/computerd-shim/dist");
});
