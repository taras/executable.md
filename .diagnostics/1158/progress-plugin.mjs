import { Plugin, Component } from "file:///private/tmp/xmd-1158-source/packages/core/api.ts";
import { API } from "file:///private/tmp/xmd-1158-source/packages/runtime/mod.ts";
import { Test } from "file:///private/tmp/xmd-1158-source/packages/testing/mod.ts";
import { until, ensure } from "file:///private/tmp/xmd-1158-source/node_modules/effection/esm/mod.js";
import { appendFile } from "node:fs/promises";
const path = "/private/tmp/xmd-1158-authenticated-work/attempts/0000/progress.jsonl";
function* note(event) {
  yield* until(appendFile(path, JSON.stringify({time:Date.now(),pid:process.pid,...event}) + "\n"));
}
export default Plugin({name:"1158-progress", *install() {
  yield* note({kind:"install"});
  yield* ensure(function* () { yield* note({kind:"plugin-cleanup"}); });
  yield* Component.around({*expand([request], next) {
    const e=request.expansion;
    if (e.name === "Test" || e.name.startsWith("Fixture.")) {
      yield* note({kind:"element-start",...e});
      yield* ensure(function* () { yield* note({kind:"element-cleanup",...e}); });
      yield* next(request);
      yield* note({kind:"element-return",...e});
    } else { yield* next(request); }
  }});
  yield* API.Process.around({*exec([options],next) {
    const id=crypto.randomUUID();
    yield* note({kind:"exec-start",id,command:options.command,cwd:options.cwd});
    yield* ensure(function* () { yield* note({kind:"exec-cleanup",id}); });
    const value=yield* next(options);
    yield* note({kind:"exec-return",id,exitCode:value.exitCode});
    return value;
  }});
  yield* Test.around({*record([result],next) {
    yield* note({kind:"test-result",result});
    yield* next(result);
  }});
}});
