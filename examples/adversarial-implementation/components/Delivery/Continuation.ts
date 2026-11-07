import { API, parseFilesFailure } from "@executablemd/runtime";
import type { Operation } from "effection";
import { z } from "zod";
import { retained } from "./observation.ts";
import { outcomeSchema } from "./records.ts";

export const props = {
  type: "object",
  properties: {
    directory: { type: "string", pattern: "^/" },
    session: { type: "string", minLength: 1 },
    own: { type: "string", minLength: 1 },
  },
  required: ["directory", "session", "own"],
  additionalProperties: false,
};

const input = z.strictObject({
  directory: z.string().startsWith("/"),
  session: z.string().min(1),
  own: z.string().min(1),
});

/**
 * Whether this reviewer's conversation may already exist. Any earlier attempt
 * by the same reviewer counts unless its own outcome proves the session was
 * never entered: the catalog offered no selectable model, or establishing the
 * session itself failed.
 */
export default function* Continuation(value: unknown): Operation<unknown> {
  const { directory, session, own } = input.parse(value);
  return yield* retained("delivery-review-continuation", z.boolean(), function* () {
    const found = yield* API.Files.operations.globFiles({
      cwd: directory,
      include: ["review-*/assignment.json", "review-*/replacement/assignment.json"],
      exclude: [],
    });
    if (!found.ok) {
      if (parseFilesFailure(found.error)?.reason === "missing") {
        return false;
      }
      throw found.error;
    }
    for (const path of found.value.filter((candidate) => candidate !== own)) {
      const assignment = yield* API.Files.operations.readTextFile({ cwd: directory, path });
      if (!assignment.ok) {
        throw assignment.error;
      }
      const reviewer = z
        .object({ reviewer: z.object({ session: z.string() }) })
        .safeParse(JSON.parse(assignment.value));
      if (reviewer.success && reviewer.data.reviewer.session !== session) {
        continue;
      }
      const text = yield* API.Files.operations.readTextFile({
        cwd: directory,
        path: path.replace(/assignment\.json$/, "outcome.json"),
      });
      if (!text.ok && parseFilesFailure(text.error)?.reason !== "missing") {
        throw text.error;
      }
      const outcome = text.ok ? outcomeSchema.safeParse(JSON.parse(text.value)) : undefined;
      const unentered =
        outcome?.success === true &&
        (outcome.data.catalog.state !== "selected" ||
          (outcome.data.turn?.state === "failed" && outcome.data.turn.stage === "session"));
      if (!unentered) {
        return true;
      }
    }
    return false;
  });
}
