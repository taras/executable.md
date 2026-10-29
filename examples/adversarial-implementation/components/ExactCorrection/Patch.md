---
description: >-
  Verify an approved patch against its base without editing the checkout. Use
  <ExactCorrection.Patch repository={repository} offer={offer} as="proof" />.
props:
  type: object
  properties:
    repository: {type: string, pattern: '^/'}
    offer: {type: object}
  required: [repository, offer]
  additionalProperties: false
returns: {type: object}
---
<ExactCorrection.Schema as="schema" />
<Parse schema={schema} as="offer"><Json value={props.offer} /></Parse>
<Let as="patch" value={"'" + offer.patch.replaceAll("'", "'\"'\"'") + "'"} />
<TempDir as="temporary" />
<Let as="index" value={"'" + (temporary + "/index").replaceAll("'", "'\"'\"'") + "'"} />
<Dir path={props.repository}>
```bash exec as="blob"
git hash-object --no-filters -- {patch}
```
<If condition={blob.exitCode !== 0 || blob.stdout.trim() !== offer.patchBlob}><Fail message="The reviewer patch bytes changed or cannot be read." /></If>
```bash exec as="tree"
set -e
GIT_INDEX_FILE={index} git read-tree {offer.baseRevision}
GIT_INDEX_FILE={index} git apply --cached --whitespace=nowarn -- {patch}
GIT_INDEX_FILE={index} git write-tree
```
<If condition={tree.exitCode !== 0 || tree.stdout.trim() !== offer.targetTree}><Fail message="The exact patch does not produce the reviewer-authorized tree from its base." /></If>
```bash exec as="baseTree"
git show -s --format=%T {offer.baseRevision}
```
<If condition={baseTree.exitCode !== 0 || baseTree.stdout.trim() === offer.targetTree}><Fail message="An exact correction must change its inspected base." /></If>
<Return value={{blob,tree,baseTree}} />
</Dir>
