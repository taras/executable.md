import { Document, Plugin } from "@executablemd/core/api";

export default Plugin({
  name: "wrapper-one",
  *install() {
    yield* Document.around({
      document: (_args, next) => `one open\n\n${next()}\n\none close\n`,
    });
    return undefined;
  },
});
