from pathlib import Path
import json,sys,hashlib
p=Path(__file__).resolve().parent;r=p.parent/'result';events=[];bad=[]
for f in (r/'timing').glob('*.json'):
 try:events.append(json.loads(f.read_text()))
 except Exception as e:bad.append({'path':str(f),'error':str(e)})
sites={x['evalOffset']:x['name'] for x in json.loads((p/'test-sites.json').read_text())['sites']}
rows=[]
for e in events:
 if e.get('suite')!='Friction' or e.get('event') not in ['test_start','process_start']:continue
 endName='test_delegate_end' if e['event']=='test_start' else 'process_end'
 ends=[x for x in events if x.get('suite')==e['suite'] and x['pid']==e['pid'] and x.get('id')==e['id'] and x.get('event')==endName]
 row={'kind':e['event'],'pid':e['pid'],'id':e['id'],'startMs':e['startMs'],'endRecords':len(ends),'elapsedMs':ends[0]['elapsedMs'] if len(ends)==1 else None}
 if e['event']=='test_start':row.update({'name':sites.get((e.get('position') or {}).get('offset')),'position':e.get('position')})
 else:row.update({'command':e['command'],'cwd':e.get('cwd'),'configuredTimeout':e.get('configuredTimeout')})
 if len(ends)==1:row['delegationReturned']=ends[0]['delegationReturned']
 rows.append(row)
for row in rows:
 if row['kind']!='process_start':continue
 matches=[t for t in rows if t['kind']=='test_start' and t['pid']==row['pid'] and t['startMs']<=row['startMs'] and (t['elapsedMs'] is None or row['startMs']<=t['startMs']+t['elapsedMs'])]
 row['testCandidates']=[{'id':t['id'],'name':t.get('name')} for t in matches]
summary={'timingRecords':len(events),'invalidOrPartialTimingFiles':bad,'timedTests':sorted([x for x in rows if x['kind']=='test_start'],key=lambda x:x['elapsedMs'] or -1,reverse=True),'timedProcesses':sorted([x for x in rows if x['kind']=='process_start'],key=lambda x:x['elapsedMs'] or -1,reverse=True),'censored': [x for x in rows if x['endRecords']!=1],'limits':'A missing end is unresolved, not successful completion. Durations measure delegation spans including observer overhead; canonical Test outcomes come from journal/CLI. Multiple containing test windows remain ambiguous. Inner work inside a nested CLI is not separately timed.'}
execution={}
for suite in ['Workflow','Sanity','Friction']:
 q=r/suite;state={'launched':(q/'started.json').exists(),'joinedReceipt':None,'helperOutcomeRecorded':(q/'outcome.json').exists(),'firstFailureRecorded':(q/'first-failure.txt').exists()}
 if (q/'joined.json').exists():
  try:state['joinedReceipt']=json.loads((q/'joined.json').read_text())
  except Exception as e:state['joinedReceiptReadError']=str(e)
 execution[suite]=state
summary['execution']=execution
summary['frictionObserved']=any(x.get('suite')=='Friction' for x in events)
(r/'summary.json').write_text(json.dumps(summary,indent=2))
manifest={}
for f in r.rglob('*'):
 if f.is_file() and f.name!='artifact-manifest.json':manifest[str(f.relative_to(r))]={'bytes':f.stat().st_size,'sha256':hashlib.sha256(f.read_bytes()).hexdigest()}
(r/'artifact-manifest.json').write_text(json.dumps(manifest,indent=2))
