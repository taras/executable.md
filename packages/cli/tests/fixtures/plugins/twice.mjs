// A wrapper that delegates twice. Nothing caches the answer and nothing counts
// the calls, so the document is projected once for each placeholder.
import { Document, Plugin } from "@executablemd/core/api";

export default Plugin({
  name: "twice",
  *install() {
    yield* Document.around({
      document: (_args, next) => `${next()}\n\n${next()}\n`,
    });
    return undefined;
  },
});
