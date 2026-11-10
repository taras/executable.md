export default {
  name: "structural-reference-fixture",
  /** @returns {import("effection").Operation<import("@executablemd/core/api").PluginInstallation | undefined>} */
  // deno-lint-ignore require-yield
  *install() {
    const props = { type: "object", properties: {}, additionalProperties: false };
    return {
      structural: [
        {
          kind: "structural",
          name: "Banner",
          origin: "tier-ph/structural",
          forms: ["paired"],
          props,
          syntax: ["<Banner><BannerLine>…</BannerLine></Banner>"],
          description: "Frame the lines written inside it.",
          context: "The lines this banner frames.",
          parent: null,
        },
        {
          kind: "structural",
          name: "BannerLine",
          origin: "tier-ph/structural",
          forms: ["paired"],
          props,
          syntax: ["<BannerLine>…</BannerLine>"],
          description: "One line of a banner.",
          context: "The line's own content.",
          parent: "Banner",
        },
      ],
      // deno-lint-ignore require-yield
      *expand() {
        throw new Error("structural-reference-fixture: handler invoked");
      },
    };
  },
};
