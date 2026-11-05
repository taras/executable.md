from pathlib import Path
import subprocess,json,os,platform,sys,hashlib
p=Path(__file__).resolve().parent;s=p.parent/'source';r=p.parent/'result'
def command(args):
 try:
  x=subprocess.run(args,text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE);return {'exitCode':x.returncode,'stdout':x.stdout,'stderr':x.stderr}
 except FileNotFoundError:return {'unavailable':True}
read=lambda *args:subprocess.check_output(['git',*args],cwd=s,text=True).strip()
assert read('rev-parse','HEAD')=='f5538fa5c1c63e95cb05b624a12d4cfb6846d006'
assert read('rev-parse','HEAD^{tree}')=='c78abcd7028c45cdaad5132400057aaff709e2b0'
metadata={'source':read('rev-parse','HEAD'),'tree':read('rev-parse','HEAD^{tree}'),'carrier':command(['git','-C',str(p.parent/'carrier'),'rev-parse','HEAD']),'platform':platform.platform(),'osRelease':Path('/etc/os-release').read_text(),'environment':{k:os.environ.get(k) for k in ['RUNNER_OS','RUNNER_ARCH','ImageOS','ImageVersion','GITHUB_RUN_ID','GITHUB_RUN_ATTEMPT','GITHUB_SHA','GITHUB_REF','DENO_DIR']},'versions':{name:command([name,'--version']) for name in ['deno','bun','node','pnpm','git']},'cpu':command(['lscpu']),'memory':command(['free','-b']),'lockSha256':hashlib.sha256((s/'deno.lock').read_bytes()).hexdigest(),'dependencyRoots':{name:(s/'node_modules'/name).exists() for name in ['.deno','.pnpm']},'porcelain':read('status','--porcelain')}
(r/(sys.argv[1]+'.json')).write_text(json.dumps(metadata,indent=2))
