import { component, fields } from "../description.ts";
import type { ReplAction } from "./actions.ts";

export const VIEWPORT = component<ReplAction>({
  name: "viewport",
  attach(node) {
    node.claim((event) => {
      const window = fields(node.input)?.["window"];
      if (typeof window !== "string") {
        return undefined;
      }
      if (event.kind === "wheel") {
        return { kind: "viewport-wheel", window, direction: event.direction };
      }
      if (
        window === "drawer" &&
        event.kind === "key" &&
        (event.key === "PageUp" || event.key === "PageDown")
      ) {
        return { kind: "reading-key", reading: "drawer", key: event.key };
      }
      return undefined;
    });
  },
});
