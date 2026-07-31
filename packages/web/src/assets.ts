/**
 * The browser assets a live form serves.
 *
 * `generated/client-bundle.ts` is built by `deno task build:web` and is not a
 * tracked file, so it is absent on a fresh checkout and present in a release. The
 * import is dynamic for exactly that reason: a static one would fail `deno check`
 * on any machine that had not run the build, including CI.
 *
 * It is contextual so a test can serve fixture bytes instead of bundling half a
 * megabyte of React it never renders.
 */

import { type Api, createApi, type Operations } from "@effectionx/context-api";
import { until } from "effection";
import type { Operation } from "effection";

export interface BrowserAssets {
  clientJs: string;
  themeCss: string;
}

export interface FormAssetsApi {
  assets(): Operation<BrowserAssets>;
}

export const FormAssets: Api<FormAssetsApi> = createApi<FormAssetsApi>("FormAssets", {
  *assets(): Operation<BrowserAssets> {
    const module = yield* until(import("../generated/client-bundle.ts"));
    return readAssets(module);
  },
});

export const assets: Operations<FormAssetsApi>["assets"] = FormAssets.operations.assets;

/**
 * The generated module is `export const` strings and numbers, so what it holds is
 * read and checked rather than trusted: a build that changed shape should say so
 * here, not serve `undefined` to a browser.
 */
function readAssets(module: unknown): BrowserAssets {
  if (typeof module !== "object" || module === null) {
    throw new Error("the generated browser bundle did not load a module");
  }
  const clientJs = "CLIENT_JS" in module ? module.CLIENT_JS : undefined;
  const themeCss = "THEME_CSS" in module ? module.THEME_CSS : undefined;
  if (typeof clientJs !== "string" || typeof themeCss !== "string") {
    throw new Error(
      "the generated browser bundle is missing CLIENT_JS or THEME_CSS — run `deno task build:web`",
    );
  }
  return { clientJs, themeCss };
}
