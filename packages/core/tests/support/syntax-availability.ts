import { expect } from "@executablemd/test-support/expect";
import type { Operation } from "effection";
import { Structural } from "../../host.ts";
import type { ExecutionInstallation } from "../../host.ts";

/** Assert the label belongs to this reference, rather than another section. */
export function expectAvailability(text: string, name: string, available: boolean): void {
  const sections = text.split(`### \`<${name}>\``);
  expect(sections).toHaveLength(2);
  expect(sections[1].split("\n### ")[0]).toContain(
    `**Available in this evaluation:** ${available ? "yes" : "no"}`,
  );
}

/** Installed authoring syntax that generated expansion must never enter. */
export function syntaxInstallation(calls: string[]): ExecutionInstallation {
  const parent = Structural({
    name: "Banner",
    origin: "test://1178",
    forms: ["paired"],
    props: { type: "object", properties: {}, additionalProperties: false },
    syntax: ["<Banner><BannerLine>…</BannerLine></Banner>"],
    description: "Frame the lines written inside it.",
    context: "The lines this banner frames.",
    parent: null,
  });
  return {
    declarations: [
      parent,
      Structural({
        ...parent,
        name: "BannerLine",
        parent: "Banner",
        syntax: ["<BannerLine>…</BannerLine>"],
      }),
    ],
    // deno-lint-ignore require-yield
    *expand(): Operation<void> {
      calls.push("handler invoked");
      throw new Error("1178: inspection entered a structural handler");
    },
  };
}
