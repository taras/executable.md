// Reports the complete active list, which every Plugin sees the same way.
import { activePlugins, Document, Plugin } from "@executablemd/core/api";

export default Plugin({
  name: "active",
  *install() {
    const names = (yield* activePlugins).map((plugin) => plugin.name).join(", ");
    yield* Document.around({
      document: (_args, next) => `active: ${names}\n\n${next()}`,
    });
    return undefined;
  },
});
