import { Qualification } from "../state.ts";
import { runSequence } from "../stage-runner.ts";
import { cwd } from "@executablemd/runtime";
import { ensureDir } from "@effectionx/fs";
export default function* RunSequence() {
  const state = yield* Qualification.expect();
  const directory = `${yield* cwd()}/.xmd-qualification-${state.names.a}`;
  yield* ensureDir(directory);
  yield* runSequence(state, directory);
  return "";
}
