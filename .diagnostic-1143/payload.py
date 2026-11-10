#!/usr/bin/env python3
import argparse, hashlib, json, os, pathlib, shutil, signal, socket, subprocess, threading, time
BASE="321eac2a07e01ca14830c275117b4e94e26bd4c9"
FIX="a40e68b903e7a322395cd2d7130657397ccf4c92"
HERE=pathlib.Path(__file__).resolve().parent
class Capture:
 def __init__(self, path):
  self.server=socket.socket(socket.AF_INET);self.server.bind(("127.0.0.1",0));self.port=self.server.getsockname()[1];self.server.listen(64);self.server.settimeout(.1)
  self.events=[];self.errors=[];self.active=0;self.stop=False;self.lock=threading.Lock();self.readers=[]
  self.thread=threading.Thread(target=self.accept);self.thread.start()
 def accept(self):
  while not self.stop:
   try: client,_=self.server.accept()
   except socket.timeout: continue
   with self.lock:self.active+=1
   t=threading.Thread(target=self.read,args=(client,),daemon=True);self.readers.append(t);t.start()
 def read(self,client):
  try:
   with client,client.makefile("rb") as f:
    for line in f:
     if len(line)>8192:raise ValueError("oversized diagnostic metadata")
     event=json.loads(line)
     allowed={"pid","instance","at","kind","id","name","location","state","compare","exitCode"}
     if set(event)-allowed:raise ValueError("unrecognized diagnostic fields")
     with self.lock:
      if len(self.events)>=500000:raise ValueError("diagnostic event cap reached")
      self.events.append(event)
  except Exception as error:
   with self.lock:self.errors.append(type(error).__name__)
  finally:
   with self.lock:self.active-=1
 def finish(self,out):
  end=time.monotonic()+10
  while self.active and time.monotonic()<end:time.sleep(.05)
  self.stop=True;self.thread.join();self.server.close()
  data={"events":self.events,"errors":self.errors,"connectionsStillOpen":self.active}
  out.write_text(json.dumps(data))
  return data

def render(source,out,port):
 text=(HERE/"observer.mjs.in").read_text()
 for token,rel in [("__CORE__","packages/core/api.ts"),("__RUNTIME__","packages/runtime/mod.ts"),("__GIT__","packages/git/api.ts")]:text=text.replace(token,json.dumps(str(source/rel)))
 text=text.replace("__PORT__",str(port))
 file=out/"observer.mjs";file.write_text(text);return file

def digest(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def head(source):return subprocess.check_output(["git","rev-parse","HEAD"],cwd=source,text=True).strip()
def status(source):return subprocess.check_output(["git","status","--porcelain=v1"],cwd=source,text=True)
def invocation(source,out,smoke=False):
 out.mkdir(parents=True,exist_ok=False)
 channel=Capture(out/"s")
 observer=render(source,out,channel.port)
 real=shutil.which("deno");assert real
 shim=out/"bin";shim.mkdir()
 shimfile=shim/"deno"
 shimfile.write_text("#!/usr/bin/env python3\nimport os,sys\na=sys.argv[1:]\nif any(x.endswith('/packages/cli/src/deno.ts') for x in a): a += ['--plugin',"+repr(str(observer))+"]\nos.execv("+repr(real)+",['deno']+a)\n")
 shimfile.chmod(0o755)
 env=dict(os.environ,PATH=str(shim)+os.pathsep+os.environ["PATH"],XMD_TEST_ARTIFACTS=str(out/"failure-journals"))
 argv=["pnpm","exec","tsx","--tsconfig","tsconfig.node.json","--test","--test-concurrency=1","packages/cli/tests/adversarial-implementation.test.ts"]
 if smoke:
  sample='<Testing><Test name="benign diagnostic smoke" timeout="20s">\n```sh exec\nsleep 15\n```\n</Test></Testing>'
  argv=[real,"run","--allow-all","--node-modules-dir=manual","--cached-only","--frozen",str(source/"packages/cli/src/deno.ts"),"run","--allow-absolute","--eval",sample,"--plugin",str(observer)]
 stamp=time.time();before=head(source);before_status=status(source)
 with (out/"stdout.log").open("wb") as stdout,(out/"stderr.log").open("wb") as stderr:
  process=subprocess.Popen(argv,cwd=source,env=env,stdout=stdout,stderr=stderr,start_new_session=True)
  killed=False
  if smoke:
   limit=time.monotonic()+15
   while not any(e["kind"]=="exec-start" for e in channel.events) and process.poll() is None and time.monotonic()<limit:time.sleep(.02)
   if process.poll() is None:
    os.killpg(process.pid,signal.SIGKILL);killed=True
  code=process.wait()
 data=channel.finish(out/"progress.json")
 receipt={"argv":argv,"cwd":str(source),"head":before,"preStatus":before_status,"postHead":head(source),"postStatus":status(source),"startedEpoch":stamp,"elapsedMs":(time.time()-stamp)*1000,"returnCode":code,"signal":-code if code<0 else None,"smokeForcedKill":killed,"events":len(data["events"]),"captureErrors":data["errors"],"connectionsStillOpen":data["connectionsStillOpen"],"observerSha256":digest(observer),"stdoutSha256":digest(out/"stdout.log"),"stderrSha256":digest(out/"stderr.log")}
 (out/"receipt.json").write_text(json.dumps(receipt,indent=2))
 if data["errors"] or data["connectionsStillOpen"]:raise RuntimeError("incomplete diagnostic channel")
 if not smoke and not any(e.get("kind")=="enter" and e.get("name")=="Fixture.Implementation" for e in data["events"]):raise RuntimeError("carrier never entered the fixture; preserve this diagnostic preflight failure")
 if before!=receipt["postHead"] or before_status!=receipt["postStatus"]:raise RuntimeError("source changed")
 return receipt,data

def main():
 parser=argparse.ArgumentParser();parser.add_argument("mode",choices=["smoke","pair"]);parser.add_argument("--baseline",type=pathlib.Path);parser.add_argument("--corrected",type=pathlib.Path,required=True);parser.add_argument("--output",type=pathlib.Path,required=True);a=parser.parse_args()
 a.output.mkdir(parents=True,exist_ok=False)
 if a.mode=="smoke":
  receipt,data=invocation(a.corrected.resolve(),a.output/"smoke",True)
  assert receipt["smokeForcedKill"] and receipt["returnCode"]==-signal.SIGKILL
  assert any(e["kind"]=="exec-start" for e in data["events"])
  assert not any(e["kind"]=="exec-end" for e in data["events"])
  (a.output/"smoke-result.json").write_text(json.dumps({"passed":True,"meaning":"metadata survives killed child without finalizer flush; no fixture executed"}))
  return
 assert os.uname().sysname=="Linux"
 versions={"node":subprocess.check_output(["node","--version"],text=True).strip(),"bun":subprocess.check_output(["bun","--version"],text=True).strip(),"deno":" ".join(subprocess.check_output(["deno","--version"],text=True).splitlines()[0].split(" ")[:2])}
 assert versions=={"node":"v22.23.4","bun":"1.4.0","deno":"deno 2.9.5"},versions
 assert head(a.baseline)==BASE and head(a.corrected)==FIX
 assert not status(a.baseline) and not status(a.corrected)
 (a.output/"host.json").write_text(json.dumps({"versions":versions,"uname":list(os.uname()),"cpuCount":os.cpu_count(),"runId":os.environ.get("GITHUB_RUN_ID"),"runAttempt":os.environ.get("GITHUB_RUN_ATTEMPT"),"observerTemplateSha256":digest(HERE/"observer.mjs.in")},indent=2))
 receipts=[]
 for label,source in [("baseline",a.baseline),("corrected",a.corrected)]:
  r,_=invocation(source.resolve(),a.output/label);receipts.append(r)
 (a.output/"pair-result.json").write_text(json.dumps({"runs":receipts,"interpretation":"one matched allocation; inspect attributed timeout before any causal conclusion; no retries"},indent=2))
 print(json.dumps({"runs":[{"head":r["head"],"returnCode":r["returnCode"],"elapsedMs":r["elapsedMs"],"events":r["events"]} for r in receipts]}))
if __name__=="__main__":main()
