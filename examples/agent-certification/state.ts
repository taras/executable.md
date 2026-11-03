import { createContext } from "effection";
import { z } from "zod";
import { configurationSchema, reportSchema } from "./report.ts";
export const privateStateSchema = z.strictObject({
  configuration: configurationSchema,
  report: reportSchema,
  marker: z.string(),
  names: z.strictObject({ a: z.string(), b: z.string(), c: z.string() }),
  identity: z.string().optional(),
  seedAccepted: z.boolean(),
  teardownExpired: z.boolean().optional(),
  turn: z.strictObject({
    accepted: z.boolean(),
    completed: z.boolean(),
    identity: z.string().optional(),
  }),
});
export type QualificationState = z.infer<typeof privateStateSchema> & { failure?: Error };
export const Qualification = createContext<QualificationState>(
  "executablemd.agent-certification/observations",
);
