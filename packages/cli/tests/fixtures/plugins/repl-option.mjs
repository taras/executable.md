import { Plugin } from "@executablemd/core/api";
import { z } from "zod";

export default Plugin({
  name: "probe-owner",
  command([cmd, args], next) {
    return next(cmd, { ...args, probeValue: { owner: this.name, schema: z.string() } });
  },
  *install(request) {
    throw new Error(`probe = ${request.options.probeValue}`);
  },
});
