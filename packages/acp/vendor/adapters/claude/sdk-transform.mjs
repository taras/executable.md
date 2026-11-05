import { createHash } from "node:crypto";

export const pristineSha256 = "fa36c6862927f6f1d0c3bff35d524a1d8fa81f1746bebfc7aeddb6fbf4b572c8";
export const declarationsSha256 =
  "544c4efabd6761a66110bf32b2e3749b77bbee4f958e2c929dd1045f52302653";

const patches = [
  [
    "class yk{options;process;",
    "class yk{nativeClose=Promise.resolve();closed=!1;options;process;",
  ],
  ["spawn(){try{this.initialize()}", "spawn(){if(this.closed)return;try{this.initialize()}"],
  [
    'spawnLocalProcess(e){let{command:t,args:n,cwd:r,env:o,signal:s}=e,i=lPe(t,n,{cwd:r,stdio:["pipe","pipe","pipe"],signal:s,env:o,windowsHide:!0}),a=new pPe("utf8"),',
    `spawnLocalProcess(e){
      let complete;
      this.nativeClose = new Promise((resolve) => { complete = resolve; });
      let {command:t,args:n,cwd:r,env:o,signal:s}=e, i;
      try {
        i=lPe(t,n,{cwd:r,stdio:["pipe","pipe","pipe"],signal:s,env:o,windowsHide:!0});
      } catch (error) {
        complete();
        throw error;
      }
      const onNativeClose = () => {
        i.off("close", onNativeClose);
        complete();
      };
      i.on("close", onNativeClose);
      let a=new pPe("utf8"),`,
  ],
  [
    'close(){if(this.spawnAbort(this.abortController.signal.aborted?u_():Error("Query closed before spawn"))',
    'waitForNativeClose(){return this.nativeClose}close(){this.closed=!0;if(this.spawnAbort(this.abortController.signal.aborted?u_():Error("Query closed before spawn"))',
  ],
  [
    "finally{t.abort()}}}next(...[e]){return this.sdkMessages.next(...[e])}",
    "finally{t.abort()}}await this.transport.waitForNativeClose?.()}next(...[e]){return this.sdkMessages.next(...[e])}",
  ],
];

export function transformSdk(source) {
  // Validate all sites before replacing any, so a partial transform is never returned.
  for (const [site] of patches) {
    const count = source.split(site).length - 1;
    if (count !== 1) {
      throw new Error(`SDK patch site must occur exactly once (found ${count}): ${site}`);
    }
  }
  if (createHash("sha256").update(source).digest("hex") !== pristineSha256) {
    throw new Error("Pristine Claude SDK SHA-256 mismatch");
  }
  for (const [site, replacement] of patches) {
    source = source.replace(site, replacement);
  }
  return source;
}
