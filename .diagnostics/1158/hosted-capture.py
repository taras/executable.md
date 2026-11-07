#!/usr/bin/env python3
"""Run one existing workload with private observational files, without editing source."""
import argparse, json, os, pathlib, subprocess, time
parser=argparse.ArgumentParser()
parser.add_argument("--source",required=True)
parser.add_argument("--output",required=True)
parser.add_argument("--bun",required=True)
parser.add_argument("--deno",required=True)
args=parser.parse_args()
root=pathlib.Path(args.source).resolve()
out=pathlib.Path(args.output).resolve()
kit=pathlib.Path(__file__).resolve().parent
out.mkdir(parents=True,exist_ok=False)
(out/"bin").mkdir()
def read(cmd):
    return subprocess.check_output(cmd,cwd=root,text=True).strip()
head=read(["git","rev-parse","HEAD"])
if head != "bd85a00406f245adffda5b296d4dc8163347cacd":
    raise SystemExit("Refusing a different source revision")
if read(["git","status","--porcelain"]):
    raise SystemExit("Refusing dirty source")
bun=pathlib.Path(args.bun).resolve()
deno=pathlib.Path(args.deno).resolve()
bunVersion=read([str(bun),"--version"])
denoVersion=read([str(deno),"--version"])
if bunVersion != "1.4.0" or not denoVersion.startswith("deno 2.9.5 "):
    raise SystemExit("Requires Bun 1.4.0 and Deno 2.9.5")
plugin=(kit/"progress-plugin.mjs").read_text().replace("/private/tmp/xmd-1158-source",str(root)).replace("/private/tmp/xmd-1158-authenticated-work/attempts/0000",str(out))
(out/"progress-plugin.mjs").write_text(plugin)
shim=(kit/"bin/deno").read_text().replace("/private/tmp/xmd-1158-authenticated-work/attempts/0000/deno-2.9.5/deno",str(deno)).replace("/private/tmp/xmd-1158-authenticated-work/attempts/0000",str(out))
(out/"bin/deno").write_text(shim)
os.chmod(out/"bin/deno",0o755)
env=dict(os.environ,PATH=str(out/"bin")+os.pathsep+os.environ["PATH"])
argv=[str(bun),"test","--timeout=300000","packages/cli/tests/adversarial-implementation.test.ts"]
meta=dict(sourceRevision=head,testedRevision=None,cwd=str(root),argv=argv,bun=bunVersion,deno=denoVersion,platform=os.uname().sysname,machine=os.uname().machine,instrumentation=[str(out/"progress-plugin.mjs"),str(out/"bin/deno")],startedAt=time.time())
(out/"capture-inputs.json").write_text(json.dumps(meta,indent=2)+"\n")
with (out/"first-output.log").open("wb") as output:
    child=subprocess.Popen(argv,cwd=root,env=env,stdout=output,stderr=subprocess.STDOUT)
    code=child.wait()
meta.update(exitCode=code,finishedAt=time.time(),sourceStatusAfter=read(["git","status","--porcelain"]))
(out/"hosted-command-receipt.json").write_text(json.dumps(meta,indent=2)+"\n")
raise SystemExit(code)
