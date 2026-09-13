import type { AnyRoute } from "./types.js";
import { type AnyElement, type DynamicElement } from "./pipeline.js";
export type { ConjoinPhases, Seed } from "./pipeline.js";
export type PhaseOf<R extends AnyRoute> = R["phases"][0];
export type PhasesOf<R extends AnyRoute> = R["phases"];
export declare function dynamic<Requirement, E>(extension: (requires: Requirement) => E, ..._valid: E extends AnyElement ? [] : [never]): DynamicElement<Requirement, Extract<E, AnyElement>>;
//# sourceMappingURL=dynamic.d.ts.map