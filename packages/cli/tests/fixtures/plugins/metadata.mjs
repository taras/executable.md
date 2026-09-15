// Composes the root's ordinary metadata and nothing else.
import { Plugin, RootMetadata } from "@executablemd/core/api";

export default Plugin({
  name: "metadata",
  *install() {
    yield* RootMetadata.around({
      metadata: (_args, next) => ({ ...next(), badge: "composed" }),
    });
    return undefined;
  },
});
