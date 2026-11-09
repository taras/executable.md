import { Agent, Component } from "@executablemd/core/api";
import { ensureDir, rm } from "@effectionx/fs";
import { z } from "zod";
import { read, write } from "../../components/Ticket/text-storage.ts";

export const props = {
  type: "object",
  properties: { variant: { type: "string" } },
  required: ["variant"],
  additionalProperties: false,
};

export default function* NativeGuide(input: unknown) {
  const { variant } = z.object({ variant: z.string() }).parse(input);
  let calls = 0;
  let path: string | undefined;
  yield* Agent.around({
    *prompt(args, next) {
      calls++;
      const text = args[0];
      path ??= text.split("Read the frozen UTF-8 file at ")[1]?.split(" before returning")[0];
      if (path === undefined || (calls === 1 && text.includes('"$defs"'))) {
        throw new Error("The native request did not stage its submission guide.");
      }
      const guide = yield* read("/", path);
      if (
        ![
          '"$defs"',
          "including an early blocker",
          "Test-only changes can affect acceptance.",
          "A mechanical assessment has no architecture, acceptance or complexity impact.",
          "a public boundary is not that reason",
        ].every((rule) => guide.includes(rule))
      ) {
        throw new Error("The staged guide is unreadable or incomplete.");
      }
      if (variant === "changed" || (variant === "correction-changed" && calls === 2)) {
        yield* write("/", path, "Changed during the native turn.");
      }
      if (variant === "missing" || variant === "unreadable") {
        yield* rm(path);
      }
      if (variant === "unreadable") {
        yield* ensureDir(path);
      }
      return yield* next(...args);
    },
  });
  yield* Component.operations.content();
  if (calls !== (variant === "correction-changed" ? 2 : 1)) {
    throw new Error("The staged submission used an additional native call.");
  }
}
