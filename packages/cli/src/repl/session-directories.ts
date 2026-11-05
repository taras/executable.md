import { content } from "@executablemd/core";
import type { IdentityComponent } from "@executablemd/core/host";
import { API, Permissions } from "@executablemd/runtime";
import { join } from "node:path";

export function sessionDirectories(workspace: string): readonly IdentityComponent[] {
  return [
    scope("REPL.AssetDir", join(workspace, "assets"), true),
    scope("REPL.ComponentDir", join(workspace, "components"), false),
  ];
}

function scope(name: string, directory: string, readOnly: boolean): IdentityComponent {
  return {
    name,
    origin: "@executablemd/cli:repl/session-directories",
    props: { type: "object", properties: {}, additionalProperties: false },
    forms: ["paired"],
    description: readOnly
      ? 'Read approved session assets. `<REPL.AssetDir><File path="mock.html" /></REPL.AssetDir>` selects the session assets directory for its content.'
      : 'Write session component source. `<REPL.ComponentDir><File path="Greeting.md">Hello</File></REPL.ComponentDir>` publishes a definition for later use.',
    as: "Optional. Captures the rendered content instead of emitting it.",
    context: "Markdown expanded in the selected session directory.",
    factory: () =>
      function* () {
        yield* API.Env.around(
          {
            *cwd() {
              return directory;
            },
          },
          { at: "min" },
        );
        if (readOnly) {
          yield* Permissions.around({
            files: ([operation], next) => (operation === "write" ? false : next(operation)),
          });
        }
        return yield* content();
      },
  };
}
