import { createContext } from "effection";
import type { Context, Operation } from "effection";

export interface ComponentModuleLoader {
  /** Load selected direct TypeScript bytes at their absolute logical file URL. */
  load(source: string, origin: string): Operation<unknown>;
}

/** Select the host loader without granting permissions or loading a module. */
export const ComponentModuleLoader: Context<ComponentModuleLoader | undefined> = createContext<
  ComponentModuleLoader | undefined
>("@executablemd/core/ComponentModuleLoader", undefined);
