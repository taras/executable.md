#!/usr/bin/env python3
import argparse, hashlib, json, os, pathlib, shutil, subprocess, sys, time

parser = argparse.ArgumentParser()
parser.add_argument('--source', required=True)
parser.add_argument('--output', required=True)
parser.add_argument('--bun', required=True)
parser.add_argument('--deno', required=True)
args = parser.parse_args()
root = pathlib.Path(args.source).resolve()
out = pathlib.Path(args.output).resolve()
kit = pathlib.Path(__file__).resolve().parent
out.mkdir(parents=True, exist_ok=False)
(out / 'locks').mkdir()
(out / 'bin').mkdir()
ledger = {'sourceRevision': 'bd85a00406f245adffda5b296d4dc8163347cacd', 'testedRevision': None, 'startedAt': time.time(), 'commands': [], 'state': 'started'}

def write(name, value):
    (out / name).write_text(json.dumps(value, indent=2) + '\n')

def capture(argv):
    return subprocess.check_output(argv, cwd=root, text=True).strip()

def command(name, argv, env=None):
    item = {'name': name, 'argv': argv, 'cwd': str(root), 'startedAt': time.time()}
    ledger['commands'].append(item)
    write('command-ledger.json', ledger)
    with (out / (name + '.log')).open('wb') as log:
        child = subprocess.Popen(argv, cwd=root, env=env, stdout=log, stderr=subprocess.STDOUT)
        code = child.wait()
    item.update(exitCode=code, finishedAt=time.time())
    write(name + '-receipt.json', item)
    write('command-ledger.json', ledger)
    return code

def locks(stage):
    result = {}
    for name in ['bun.lock', 'deno.lock', 'pnpm-lock.yaml']:
        data = (root / name).read_bytes()
        target = out / 'locks' / (stage + '-' + name)
        target.write_bytes(data)
        result[name] = {'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data)}
    (out / (stage + '-tracked.diff')).write_bytes(subprocess.check_output(['git', 'diff', '--binary', 'HEAD'], cwd=root))
    (out / (stage + '-status.txt')).write_text(capture(['git', 'status', '--porcelain=v1']))
    write(stage + '-locks.json', result)
    changed = capture(['git', 'diff', '--name-only', 'HEAD']).splitlines()
    if any(path != 'bun.lock' for path in changed):
        raise RuntimeError('Unexpected tracked preparation delta: ' + repr(changed))

snapshot = f'''import {{ main }} from "effection";
import {{ writeTextFile }} from "@effectionx/fs";
import {{ hostState }} from {json.dumps((root / 'scripts/lib/prepared-state.ts').as_uri())};
import {{ trackedState }} from {json.dumps((root / 'scripts/lib/tracked-fingerprint.ts').as_uri())};
main(function* () {{
  const host = yield* hostState({json.dumps(str(root))});
  const tracked = [...yield* trackedState({json.dumps(str(root))})];
  yield* writeTextFile(Deno.args[0], JSON.stringify({{host, tracked}}));
}});
'''
(out / 'snapshot.mjs').write_text(snapshot)
deno = str(pathlib.Path(args.deno).resolve())
bun = str(pathlib.Path(args.bun).resolve())
denoflags = [deno, 'run', '--quiet', '--allow-all', '--frozen', '--cached-only', '--node-modules-dir=manual', '--config', str(root / 'deno.json')]

def fingerprint(stage):
    target = out / (stage + '-fingerprint.json')
    code = command(stage + '-fingerprint', denoflags + [str(out / 'snapshot.mjs'), str(target)])
    if code != 0:
        raise RuntimeError('Fingerprint failed; first output preserved: ' + stage)
    return json.loads(target.read_text())

try:
    if capture(['git', 'rev-parse', 'HEAD']) != ledger['sourceRevision'] or capture(['git', 'status', '--porcelain']):
        raise RuntimeError('Requires clean exact failing source before preparation')
    if (root / 'node_modules').exists():
        raise RuntimeError('Requires fresh source without an installed tree')
    ledger['versions'] = {'bun': capture([bun, '--version']), 'deno': capture([deno, '--version']), 'node': capture(['node', '--version'])}
    if ledger['versions']['bun'] != '1.4.0' or not ledger['versions']['deno'].startswith('deno 2.9.5 '):
        raise RuntimeError('Wrong selected runtime versions')
    ledger['environment'] = {k: os.environ.get(k) for k in ['PATH', 'DENO_DIR', 'RUNNER_OS', 'RUNNER_ARCH', 'ImageOS', 'ImageVersion']}
    (out / 'clean-tracked-index.txt').write_bytes(subprocess.check_output(['git', 'ls-files', '--stage', '-z'], cwd=root))
    locks('clean')
    if command('prepare-deno-deps', [deno, 'task', 'deps']) != 0:
        raise RuntimeError('deno task deps failed; no repeat')
    locks('after-deps')
    fingerprint('after-deps')
    if command('prepare-bun-install', [bun, 'install']) != 0:
        raise RuntimeError('bun install failed; no repeat')
    locks('after-bun')
    baseline = fingerprint('after-bun')
    code = '''import * as effection from "effection"; import * as processApi from "@effectionx/process"; import {createRequire} from "node:module"; const require=createRequire(new URL("./package.json", import.meta.url)); console.log(JSON.stringify({esm:{effection:import.meta.resolve("effection"),process:import.meta.resolve("@effectionx/process")},require:{effection:require.resolve("effection"),process:require.resolve("@effectionx/process")},loaded:{effection:typeof effection.main,process:typeof processApi.exec}}));'''
    if command('bun-resolution', [bun, '--eval', code]) != 0:
        raise RuntimeError('Bun resolution observation failed')
    if command('deno-resolution', [deno, 'eval', '--frozen', '--cached-only', '--node-modules-dir=manual', '--config', str(root / 'deno.json'), code]) != 0:
        raise RuntimeError('Deno resolution observation failed')
    manifests = {}
    for package in ['effection', '@effectionx/process']:
        path = (root / 'node_modules' / package / 'package.json').resolve()
        data = path.read_bytes()
        manifests[package] = {'path': str(path), 'sha256': hashlib.sha256(data).hexdigest(), 'version': json.loads(data)['version']}
    write('resolved-manifests.json', manifests)
    plugin = (kit / 'progress-plugin.mjs').read_text().replace('/private/tmp/xmd-1158-source', str(root)).replace('/private/tmp/xmd-1158-authenticated-work/attempts/0000', str(out))
    (out / 'progress-plugin.mjs').write_text(plugin)
    shim = (kit / 'bin/deno').read_text().replace('/private/tmp/xmd-1158-authenticated-work/attempts/0000/deno-2.9.5/deno', deno).replace('/private/tmp/xmd-1158-authenticated-work/attempts/0000', str(out))
    (out / 'bin/deno').write_text(shim)
    os.chmod(out / 'bin/deno', 0o755)
    prefix = f'''import {{main}} from {json.dumps((root / 'node_modules/effection/esm/mod.js').as_uri())};
import {{writeTextFile}} from {json.dumps((root / 'node_modules/@effectionx/fs/dist/mod.js').as_uri())};
import {{runShardFiles}} from {json.dumps((root / 'scripts/lib/runtime-tests.ts').as_uri())};
main(function* () {{
 const result = yield* runShardFiles("bun", [process.argv[2]], new URL({json.dumps(root.as_uri() + '/')}));
 yield* writeTextFile(process.argv[3], JSON.stringify(result));
}});
'''
    (out / 'prefix.mjs').write_text(prefix)
    files = ['packages/acp/tests/acceptance.test.ts', 'packages/acp/tests/acpx-transient-env.test.ts', 'packages/cli/tests/adversarial-implementation.test.ts']
    for i, file in enumerate(files):
        name = f'prefix-{i+1}'
        env = dict(os.environ)
        if i == 2:
            env['PATH'] = str(out / 'bin') + os.pathsep + env['PATH']
        code = command(name, [bun, 'run', str(out / 'prefix.mjs'), file, str(out / (name + '-outcome.json'))], env)
        after = fingerprint('after-' + name)
        locks('after-' + name)
        if after != baseline:
            raise RuntimeError('Repository-owned state moved during ' + file + '; preserved before any subsequent file')
        if code != 0:
            raise RuntimeError('Runner failed at ' + file)
        outcome = json.loads((out / (name + '-outcome.json')).read_text())
        if outcome.get('failure'):
            ledger['testFailure'] = outcome['failure']
            raise RuntimeError('Original workload failed at ' + file)
    ledger['state'] = 'completed'
except Exception as error:
    ledger['state'] = 'stopped'
    ledger['reason'] = str(error)
    print(str(error), file=sys.stderr)
finally:
    ledger['finishedAt'] = time.time()
    ledger['sourceStatusAfter'] = capture(['git', 'status', '--porcelain=v1'])
    write('command-ledger.json', ledger)
    for path in sorted(out.rglob('*')):
        if path.is_file():
            print(str(path.relative_to(out)), path.stat().st_size, hashlib.sha256(path.read_bytes()).hexdigest())
sys.exit(0 if ledger['state'] == 'completed' else 1)
