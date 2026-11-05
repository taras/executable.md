import { describe, it } from "@executablemd/test-support/bdd";
import { runAdversarialJourney } from "./support/adversarial-journey.ts";

describe("adversarial implementation example", () => {
  it("runs the Friction Markdown journeys without native models", () =>
    runAdversarialJourney("Friction"));
});
