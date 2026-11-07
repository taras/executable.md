import { Component, ComponentModuleLoader } from "@executablemd/core/api";
import { exists, readTextFile, writeTextFile } from "@effectionx/fs";
import { ensure } from "effection";
import { z } from "zod";

export const props = {
  type: "object",
  properties: {
    events: { type: "string" },
    reservation: { type: "string" },
    mode: { enum: ["observe", "absent"], default: "observe" },
  },
  required: ["events", "reservation"],
  additionalProperties: false,
};
const input = z
  .object({
    events: z.string().startsWith("/"),
    reservation: z.string().startsWith("/"),
    mode: z.enum(["observe", "absent"]),
  })
  .strict();
const target = "/scripts/runtime-test-exclusions.ts";

/**
 * Delegate the installed module loader for the enclosed content, recording each
 * target exclusion evaluation, the end of its owning scope, and whether the
 * amendment reservation existed at both points. `absent` removes the loader
 * from the enclosed content's context instead.
 */
export default function* Loader(value: unknown) {
  const selected = input.parse(value);
  const inner = yield* ComponentModuleLoader.get();
  function* record(event: string) {
    const previous = (yield* exists(selected.events))
      ? z.array(z.json()).parse(JSON.parse(yield* readTextFile(selected.events)))
      : [];
    yield* writeTextFile(
      selected.events,
      JSON.stringify([...previous, { event, reserved: yield* exists(selected.reservation) }]),
    );
  }
  if (selected.mode === "absent" || inner === undefined) {
    yield* ComponentModuleLoader.set(undefined);
  } else {
    yield* ComponentModuleLoader.set({
      *load(source, origin) {
        if (!origin.endsWith(target)) {
          return yield* inner.load(source, origin);
        }
        yield* record("load");
        yield* ensure(function* () {
          yield* record("cleanup");
        });
        return yield* inner.load(source, origin);
      },
    });
  }
  return yield* Component.operations.content();
}
