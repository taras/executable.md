---
props: {type: object, properties: {guides: {type: boolean, default: false}}, additionalProperties: false}
returns: {type: object}
---

```bash exec as="prepared"
set -eu
mkdir repository
ssh-keygen -q -t ed25519 -N '' -f signer
printf 'workflow-test ' > allowed-signers
cat signer.pub >> allowed-signers
git -C repository init -q
git -C repository config user.name Workflow
git -C repository config user.email workflow@example.invalid
git -C repository config commit.gpgsign true
git -C repository config gpg.format ssh
git -C repository config gpg.ssh.program ssh-keygen
git -C repository config user.signingkey "$PWD/signer"
git -C repository config gpg.ssh.allowedSignersFile "$PWD/allowed-signers"
printf 'obsolete view factory\n' > repository/legacy.fixture
git -C repository add legacy.fixture
git -C repository commit -qm base
pwd -P
```
<If condition={prepared.exitCode !== 0}><Fail message={prepared.stderr} /></If>
<Let as="temporary" value={prepared.stdout.trim()} />
<Let as="fixture" value={{root:temporary,repository:temporary + "/repository",directory:temporary + "/work"}} />
<If condition={props.guides}>
<Dir path={fixture.repository}>
<File path=".agents/planner.md">Planner test instructions: preserve approvals and produce only the assigned plan or review.</File>
<File path=".agents/implementor.md">Implementor test instructions: use the accepted plan and existing APIs.</File>
```bash exec as="guides"
git add .agents
git commit -qm 'selected source role guides'
```
<If condition={guides.exitCode !== 0}><Fail message={guides.stderr} /></If>
</Dir>
</If>
<Return value={fixture} />
