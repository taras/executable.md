import { Document, Plugin } from "@executablemd/core/api";

export default Plugin({
  name: "wrapper-one",
  *install() {
    yield* Document.around({
      *document(_args, next) {
        return `one open\n\n${yield* next()}\n\none close\n`;
      },
    });
    return undefined;
  },
});
