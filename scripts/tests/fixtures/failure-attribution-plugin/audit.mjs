import { Plugin } from "@executablemd/core/api";
import { FsApi, writeTextFile } from "@effectionx/fs";
import { ensure } from "effection";
import process from "node:process";

export default Plugin({
  name: "failure-attribution-filesystem-audit",
  *install() {
    const calls = [];
    const target = process.env.XMD_TEST_ARTIFACTS;
    const audit = process.env.XMD_AUDIT_PATH;
    yield* ensure(function* () {
      if (audit) {
        yield* writeTextFile(audit, JSON.stringify(calls));
      }
    });
    const handlers = {};
    for (const name of ["stat", "lstat", "readdir", "readdirDirents", "rm", "copyFile", "readTextFile", "writeTextFile", "exists", "ensureDir", "ensureFile", "emptyDir"]) {
      handlers[name] = function* (args, next) {
        if (target && args.some((arg) => typeof arg === "string" && arg.startsWith(target))) {
          calls.push({ name, path: args[0] });
        }
        return yield* next(...args);
      };
    }
    yield* FsApi.around(handlers);
  },
});
