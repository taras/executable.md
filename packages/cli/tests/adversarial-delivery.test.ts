import { describe, it } from "@executablemd/test-support/bdd";
import { runAdversarialJourney } from "./support/adversarial-journey.ts";

describe("adversarial implementation example", () => {
  it("runs the Delivery Markdown journeys without native models", () =>
    runAdversarialJourney("Delivery"));
});
