import { main, until } from "effection";
import { exec } from "@effectionx/process";
import { fileSha256 } from "./digest.ts";
import { hostBinary, tarballUrl, WORKERD_VERSION } from "./manifest.ts";

const vendorDir = new URL("./vendor/", import.meta.url);

main(function* () {
  const binary = hostBinary();
  const target = new URL("./workerd", vendorDir);

  if (exists(target)) {
    const digest = yield* fileSha256(target);
    if (digest === binary.sha256) {
      console.log(`workerd ${WORKERD_VERSION} already fetched and verified`);
      return;
    }
    console.log(`existing vendor/workerd digest mismatch, refetching`);
    Deno.removeSync(target);
  }

  Deno.mkdirSync(vendorDir, { recursive: true });

  const url = tarballUrl(binary);
  console.log(`fetching ${url}`);
  const response = yield* until(fetch(url));
  if (!response.ok) {
    throw new Error(`fetch failed: ${response.status} ${url}`);
  }
  const bytes = new Uint8Array(yield* until(response.arrayBuffer()));
  const tarball = new URL("./workerd.tgz", vendorDir);
  Deno.writeFileSync(tarball, bytes);

  yield* exec("tar", {
    arguments: ["xzf", tarball.pathname, "-C", vendorDir.pathname, binary.binaryEntry],
  }).expect();

  const extracted = new URL(`./${binary.binaryEntry}`, vendorDir);
  Deno.renameSync(extracted, target);
  Deno.chmodSync(target, 0o755);
  Deno.removeSync(new URL("./package", vendorDir), { recursive: true });
  Deno.removeSync(tarball);

  const digest = yield* fileSha256(target);
  if (digest !== binary.sha256) {
    Deno.removeSync(target);
    throw new Error(
      `workerd digest mismatch: expected ${binary.sha256}, fetched ${digest}`,
    );
  }
  console.log(`workerd ${WORKERD_VERSION} verified: sha256 ${digest}`);
});

function exists(url: URL): boolean {
  try {
    Deno.statSync(url);
    return true;
  } catch {
    return false;
  }
}
