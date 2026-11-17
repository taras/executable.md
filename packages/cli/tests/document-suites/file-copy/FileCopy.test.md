# File.Copy

<Test name="Copies the complete binary file into independent storage">
<TempDir>
<Cwd as="directory" />

Generate the binary fixture in the test directory.

```ts eval
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { until } from "effection";
yield* (function* () {
  const fixture = new Uint8Array(8 * 1024 * 1024 + 1);
  fixture[fixture.length - 1] = 0xff;
  yield* until(writeFile(join(directory, "source.bin"), fixture));
})();
```

<File.Copy from="source.bin" to="destination.bin" />

```ts eval
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { until } from "effection";
const verified = yield* (function* () {
  const fixture = new Uint8Array(8 * 1024 * 1024 + 1);
  fixture[fixture.length - 1] = 0xff;
  const source = join(directory, "source.bin");
  const destination = join(directory, "destination.bin");
  const original = (yield* until(readFile(source))).equals(fixture);
  const copy = (yield* until(readFile(destination))).equals(fixture);
  yield* until(writeFile(destination, Uint8Array.of(42)));
  return { original, copy, independent: (yield* until(readFile(source))).equals(fixture) };
})();
```

<AssertEquals actual={verified} expected={{ original: true, copy: true, independent: true }} />
</TempDir>
</Test>

<Test name="Refuses paired form before expanding its content">
<TempDir>
<File path="source.txt">source</File>
<Execution host="run" source={'<File.Copy from="source.txt" to="copy.txt">\n\n<File path="sentinel.txt">ran</File>\n\n</File.Copy>\n'} as="child">
<CollectOutput as="output" />
<AssertStringIncludes actual={output} expected="self-closing" />
</Execution>
<Glob include={["*.txt"]} as="files" />
<AssertEquals actual={files} expected={["source.txt"]} />
</TempDir>
</Test>
