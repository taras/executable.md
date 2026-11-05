from pathlib import Path
import subprocess,json,datetime,sys,hashlib
p=Path(__file__).resolve().parent;s=p.parent/'source';r=p.parent/'result';suite=sys.argv[1]
assert suite in ['Workflow','Sanity','Friction']
read=lambda *a:subprocess.check_output(['git',*a],cwd=s,text=True).strip()
assert read('rev-parse','HEAD')=='f5538fa5c1c63e95cb05b624a12d4cfb6846d006'
assert read('status','--porcelain')==''
assert read('rev-parse','HEAD^{tree}')=='c78abcd7028c45cdaad5132400057aaff709e2b0'
sites=json.loads((p/'test-sites.json').read_text())
assert hashlib.sha256((s/'examples/adversarial-implementation/tests/Friction.test.md').read_bytes()).hexdigest()==sites['frictionSourceSha256']
q=r/suite; q.mkdir()
a=['deno','run','--allow-all','--frozen','--node-modules-dir=manual','--cached-only','--config',str(s/'deno.json'),str(p/'harness.ts'),suite]
now=lambda:datetime.datetime.now(datetime.timezone.utc).isoformat()
lock=hashlib.sha256((s/'deno.lock').read_bytes()).hexdigest()
(q/'launcher-intent.json').write_text(json.dumps({'at':now(),'argv':a,'source':read('rev-parse','HEAD'),'tree':read('rev-parse','HEAD^{tree}'),'lockBefore':lock,'automaticRetries':0},indent=2))
with (q/'stdout.txt').open('x') as out,(q/'stderr.txt').open('x') as err:
 child=subprocess.Popen(a,cwd=s,stdout=out,stderr=err);(q/'started.json').write_text(json.dumps({'at':now(),'pid':child.pid}));code=child.wait()
(q/'joined.json').write_text(json.dumps({'at':now(),'exitCode':code,'harnessJoined':True,'headAfter':read('rev-parse','HEAD'),'porcelainAfter':read('status','--porcelain'),'lockAfter':hashlib.sha256((s/'deno.lock').read_bytes()).hexdigest()},indent=2))
assert read('status','--porcelain')=='' and lock==hashlib.sha256((s/'deno.lock').read_bytes()).hexdigest()
if suite=='Sanity' and code==0:
 events=[json.loads(x.read_text()) for x in (r/'timing').glob('*.json')];events=[x for x in events if x['suite']=='Sanity'];kinds={x['event'] for x in events};required={'plugin_installed','test_start','test_delegate_end','process_start','process_end'}
 assert required<=kinds,'Timing hooks did not all fire; no Friction dispatch is allowed'
 assert sum(x['event']=='test_start' for x in events)==1
 assert sum(x['event']=='process_start' for x in events)==1
 assert all(x.get('delegationReturned',True) for x in events)
 (q/'hook-check.json').write_text(json.dumps({'allHooksObserved':True,'testStarts':1,'processStarts':1}))
raise SystemExit(code)
