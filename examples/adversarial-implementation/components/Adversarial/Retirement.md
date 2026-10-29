---
description: 'Check that the migration retired its named files. Use <Adversarial.Retirement repository={repository} paths={api.migration.retirePaths} />.'
props:
  type: object
  properties:
    repository: {type: string, pattern: '^/'}
    paths: {type: array, items: {type: string, minLength: 1}}
  required: [repository, paths]
  additionalProperties: false
returns: {type: array}
---

<Let as="index" value={0} />
<Let as="removed" value={[]} />
<Dir path={props.repository}>
<Loop max={Math.max(1,props.paths.length)}>
<If condition={index >= props.paths.length}><Break /></If>
<Let as="path" value={props.paths[index]} />
<If condition={path.startsWith("/") || path.split("/").includes("..") || path === "."}><Fail message="Retirement names literal repository-relative paths." /></If>
<Let as="quoted" value={"'" + path.replaceAll("'","'\"'\"'") + "'"} />
```bash exec as="absent"
test ! -e {quoted} && test ! -L {quoted}
```
<If condition={absent.exitCode !== 0}><Fail message={"The migration still depends on a path it promised to retire: " + path} /></If>
<Let as="removed" value={[...removed,path]} />
<Let as="index" value={index + 1} />
</Loop>
</Dir>
<Return value={removed} />
