// A Plugin that declares structural syntax and nothing else — no Markdown
// component anywhere in it.
//
// It exists because the retained catalog has two arms and only one of them used
// to reach `xmd syntax` and `<Plan>`'s validation. A construct a run expands but
// a check has never heard of is the defect: a Plan would be refused for writing
// syntax the run supplies.
//
// A construct renders nothing on its own, and a region's chunks are the
// handler's rather than the document's — so what this one does with the text it
// read is announce it, which is what a test outside the run can observe.
import { Plugin } from "@executablemd/core/api";
import { Structural } from "@executablemd/core/host";

const ORIGIN = "fixture/structural";

const NO_PROPS = { type: "object", properties: {}, additionalProperties: false };

export default Plugin({
  name: "structural",
  // deno-lint-ignore require-yield
  *install() {
    return {
      structural: [
        Structural({
          name: "Banner",
          origin: ORIGIN,
          forms: ["paired"],
          props: NO_PROPS,
          syntax: ["<Banner><BannerLine>…</BannerLine></Banner>"],
          description: "Frame the lines written inside it.",
          context: "The lines this banner frames.",
          parent: null,
        }),
        Structural({
          name: "BannerLine",
          origin: ORIGIN,
          forms: ["paired"],
          props: NO_PROPS,
          syntax: ["<BannerLine>…</BannerLine>"],
          description: "One line of a banner.",
          context: "The line's own content.",
          parent: "Banner",
        }),
      ],
      *expand(request) {
        const lines = [];
        for (const region of request.regions) {
          const subscription = yield* yield* region.expand();
          for (;;) {
            const next = yield* subscription.next();
            if (next.done) {
              break;
            }
            lines.push(next.value.text);
          }
        }
        console.error(`structural-fixture: expanded ${lines.join("").trim()}`);
      },
    };
  },
});
