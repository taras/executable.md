import { getExpansion } from "@executablemd/core";
import { Component } from "@executablemd/core/api";
import { API } from "@executablemd/runtime";
import { scoped } from "effection";
import { z } from "zod";
import { describe, read, stateLimit } from "../../../components/Ticket/text-storage.ts";

export const props = {
  type: "object",
  properties: { root: { type: "string", pattern: "^/" } },
  required: ["root"],
  additionalProperties: false,
};
export const returns = { type: "object" };
const owners = [
  "Ticket.Load",
  "Ticket.LoadState",
  "Ticket.Schema",
  "Ticket.Envelope",
  "Ticket.Publish",
  "Ticket.Advance",
  "Ticket.Gate",
  "Ticket.Continue",
  "Ticket.Step",
  "Phase.Schema",
  "Phase.Response",
  "Phase.SubmissionGuide",
  "Phase.SubmissionInstructions",
  "Phase.Request",
  "Phase.Instructions",
  "Phase.Profile",
  "Phase.Run",
  "Phase.Role",
  "Phase.Correct",
];

export default function RecoveryOwner(value: unknown) {
  return scoped(function* () {
    const { root } = z.strictObject({ root: z.string().startsWith("/") }).parse(value);
    const directory = root.replace(/\/$/, "") + "/examples/adversarial-implementation/components/";
    const definitions: { name: string; path: string; utf8Bytes: number; sha256: string }[] = [];
    let reading: { path: string; text: string }[] = [];
    yield* API.Fs.around({
      *readTextFile([path], next) {
        const text = yield* next(path);
        reading.push({ path, text });
        return text;
      },
    });
    const expansion = yield* getExpansion();
    for (const name of owners) {
      reading = [];
      yield* Component.operations.importComponent(name, expansion.position);
      const relative = name.replaceAll(".", "/");
      const selected = reading.filter(
        (item) =>
          item.path === directory + relative + ".md" || item.path === directory + relative + ".ts",
      );
      if (selected.length !== 1) {
        throw new Error(
          "Joined-response owner mismatch for " +
            name +
            "; select the original prepared owning include.",
        );
      }
      const retained = yield* API.Process.operations.exec({
        command: [
          "git",
          "show",
          "HEAD:" +
            "examples/adversarial-implementation/components/" +
            selected[0].path.slice(directory.length),
        ],
        cwd: root,
      });
      if (retained.exitCode !== 0 || retained.stdout !== selected[0].text) {
        throw new Error(
          "The effective owning definition differs from its prepared Git source: " + name,
        );
      }
      definitions.push({ name, ...describe(selected[0].path, selected[0].text) });
    }
    const control = directory + "Ticket/control.ts";
    const controlText = yield* read("/", control, stateLimit);
    return { definitions, control: describe(control, controlText) };
  });
}
