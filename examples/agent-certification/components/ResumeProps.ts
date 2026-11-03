import { Qualification } from "../state.ts";
export default function* ResumeProps() {
  const state = yield* Qualification.expect();
  return { configuration: state.configuration, names: state.names };
}
