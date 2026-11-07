import { Component, Execution, Plugin } from "@executablemd/core/api";
import { Stdio } from "@effectionx/process";
import { scoped } from "effection";

const prefix = "[preparation-profile] ";
const variants = ["success", "validation", "overage", "missing", "uncertain", "identity"];

function sourceMatches(path: string | undefined, suffix: string): boolean {
  const normalized = path?.replaceAll("\\", "/");
  return normalized === suffix || normalized?.endsWith(`/${suffix}`) === true;
}

export default Plugin({
  name: "preparation-profile",
  *install() {
    yield* Execution.around({
      *document([documentRequest], continueDocument) {
        const identity = documentRequest.props.identity === true;
        const root =
          typeof documentRequest.props.manifest === "string"
            ? documentRequest.props.manifest
            : "preparation-test-root";
        const clockDomain = `performance:${performance.timeOrigin}`;
        let sequence = 0;
        let variantCount = 0;
        let variantOrdinal: number | undefined = identity ? 6 : undefined;
        let inspecting = false;
        let inputCount = 0;
        let inputOrdinal: number | undefined;

        yield* Component.around({
          *expand([request], next) {
            const { expansion } = request;
            const position = expansion.position;
            const previousVariant = variantOrdinal;
            const previousInspection = inspecting;
            const previousInput = inputOrdinal;
            let interval: string | undefined;
            if (
              sourceMatches(position?.path, "tests/preparation-cases.md") &&
              expansion.name === "Test" &&
              position?.line === 7
            ) {
              interval = "shared-test";
            } else if (
              sourceMatches(position?.path, "tests/preparation-cases.md") &&
              expansion.name === "TempDir" &&
              position?.line === 9
            ) {
              interval = "variant";
              variantOrdinal = ++variantCount;
            } else if (
              sourceMatches(position?.path, "tests/preparation-cases.md") &&
              expansion.name === "Execution" &&
              position?.line === 41
            ) {
              interval = "journey";
            } else if (identity && sourceMatches(position?.path, "tests/preparation-journey.md")) {
              if (expansion.name === "Ticket.Run" && position?.line === 11) {
                interval = "identity-planning";
              } else if (expansion.name === "Ticket.Gate" && position?.line === 14) {
                interval = "planning-checked";
              } else if (expansion.name === "Ticket.Inputs" && position?.line === 15) {
                interval = "initial-inspection";
                inspecting = true;
              }
            } else if (
              inspecting &&
              sourceMatches(position?.path, "Ticket/Inputs.md") &&
              expansion.name === "Ticket.Hydrate" &&
              position?.line === 31
            ) {
              interval = "input-hydration";
              inputOrdinal = ++inputCount;
            } else if (
              inspecting &&
              inputOrdinal !== undefined &&
              sourceMatches(position?.path, "Ticket/Hydrate.md") &&
              expansion.name === "Dir" &&
              position?.line === 11
            ) {
              interval = "hydrate-directory";
            }

            if (interval === undefined) {
              yield* next(request);
              return;
            }
            const variant = variantOrdinal;
            const input = inputOrdinal;
            const emit = (edge: string): void => {
              const milliseconds = performance.now();
              const eventSequence = ++sequence;
              console.error(
                prefix +
                  JSON.stringify({
                    clockDomain,
                    root,
                    sequence: eventSequence,
                    eventKey: `${clockDomain}:${root}:${eventSequence}`,
                    expansionId: expansion.id,
                    position,
                    interval,
                    variantOrdinal: variant,
                    variant: variant === undefined ? undefined : variants[variant - 1],
                    inputOrdinal: input,
                    milliseconds,
                    edge,
                  }),
              );
            };
            emit("enter");
            let returned = false;
            try {
              yield* next(request);
              returned = true;
            } finally {
              emit(returned ? "return" : "unwind");
              variantOrdinal = previousVariant;
              inspecting = previousInspection;
              inputOrdinal = previousInput;
            }
          },
          *applyBoundModifiers([modifiers, request], next) {
            if (
              !sourceMatches(
                request.position?.path,
                "examples/adversarial-implementation/tests/Preparation.test.md",
              ) ||
              request.position?.line !== 84 ||
              request.position.column !== 1 ||
              request.language !== "bash"
            ) {
              yield* next(modifiers, request);
              return;
            }
            yield* scoped(function* () {
              const decoder = new TextDecoder();
              let pending = "";
              const markers: string[] = [];
              const collect = (text: string): void => {
                pending += text;
                for (
                  let newline = pending.indexOf("\n");
                  newline !== -1;
                  newline = pending.indexOf("\n")
                ) {
                  const line = pending.slice(0, newline);
                  pending = pending.slice(newline + 1);
                  if (line.startsWith(prefix)) {
                    markers.push(line);
                  }
                }
              };
              yield* Stdio.around({
                *stderr([bytes], forward) {
                  collect(decoder.decode(bytes, { stream: true }));
                  yield* forward(bytes);
                },
              });
              try {
                yield* next(modifiers, request);
              } finally {
                collect(decoder.decode());
                for (const marker of markers) {
                  console.error(marker);
                }
              }
            });
          },
        });
        yield* continueDocument(documentRequest);
      },
    });
    return undefined;
  },
});
