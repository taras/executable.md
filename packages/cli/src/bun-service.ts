import { randomBytes } from "node:crypto";
import process from "node:process";
import type { Operation } from "effection";
import { inheritedEnvironment, installHostService } from "./service-host.ts";

export function useBunService(): Operation<void> {
  return installHostService({
    token: () => randomBytes(32).toString("hex"),
    environment: () => inheritedEnvironment(process.env),
    stdout(bytes) {
      process.stdout.write(bytes);
    },
    stderr(bytes) {
      process.stderr.write(bytes);
    },
  });
}
