import { Plugin } from "@executablemd/core/api";
import { z } from "zod";

export default Plugin({
  name: "probe-override",
  *command([cmd, args], next) {
    const definitions = yield* next(cmd, args);
    return {
      ...definitions,
      probeValue: {
        ...definitions.probeValue,
        schema: z.string().transform((value) => `overridden ${value}`),
      },
    };
  },
});
