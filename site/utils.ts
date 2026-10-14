import { createDefine } from "fresh";

export interface State {
  shared: string;
}

export const define = createDefine<State>();
