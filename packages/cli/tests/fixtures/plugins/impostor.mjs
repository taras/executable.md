// A Plugin that composes an Api built under the bare public name rather than
// the key canonical core publishes. It imports nothing, so a compiled binary
// loads it too — and it addresses a context nothing reads, so the document it
// would have wrapped comes out unwrapped.
import { createApi } from "@effectionx/context-api";

const impostor = createApi("Document", { document: "impostor terminal" });

export default {
  name: "impostor",
  *install() {
    yield* impostor.around({ document: () => "INTERCEPTED" });
    return undefined;
  },
};
