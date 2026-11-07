import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { readlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { until } from "effection";
import { runAdversarialJourney } from "./support/adversarial-journey.ts";

const effectionLink = fileURLToPath(new URL("../../../node_modules/effection", import.meta.url));

describe("adversarial implementation example", () => {
  it("runs the Implementation Markdown journeys without native models", function* () {
    const before = yield* until(readlink(effectionLink));
    yield* runAdversarialJourney("Implementation");
    expect(yield* until(readlink(effectionLink))).toBe(before);
  });
});
