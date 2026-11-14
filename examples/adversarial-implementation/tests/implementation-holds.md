```bash exec as="location"
pwd -P
```
<Let as="root" value={location.stdout.trim()} />
```bash exec as="commandSetting"
printf '%s' "$XMD_EXAMPLE_COMMAND"
```
<Let as="runner" value={commandSetting.stdout || "deno run --allow-all --node-modules-dir=manual --cached-only --frozen '" + root.replaceAll("'","'\"'\"'") + "/packages/cli/src/deno.ts' run --allow-absolute"} />

<Test name="G6 unavailable evidence source identities policy and occupied work hold without calls" timeout="90s">
<Each in={["unselected","missing-evidence","missing-task","oversized","revision","dirty","sessions","occupied","policy","missing-source","sibling","outside","outside-error","alias"]} let="scenario">
<TempDir>
<Fixture.Repository guides={true} as="fixture" />
<Dir path={fixture.repository}>
```bash exec as="observed"
git rev-parse HEAD
```
</Dir>
<Let as="source" value={{head:observed.stdout.trim()}} />
<Let as="evidence" value={fixture.root + "/accepted.md"} />
<Let as="initialText" value={scenario === "oversized" ? "Accepted evidence. ".repeat(4000) : "Accepted scope and checks."} />
<Dir path={fixture.root}><File path="accepted.md">{initialText}</File></Dir>
<Let as="assessment" value={{mechanical:false,architecture:false,acceptance:true,risk:null,reason:"Inspect the accepted behavior.",evidence:[evidence]}} />
<Let as="task" value={{work:"test",repository:fixture.repository,directory:fixture.directory,revision:source.head,request:"normal",inputs:[evidence],sessions:{planner:"original-planner",implementor:"original-implementor",architect:"conditional-architect"},providers:{architect:"codex",planner:"claude",implementor:"claude"},maxResponseCorrections:0,maxCorrections:3,maxApiRepairs:3,assessment,scope:{decisions:{evidence:[evidence],openQuestions:[]},implementation:{ready:true,evidence:[evidence]},sharedApi:{needed:false,evidence:[evidence]},migration:null}}} />
<Let as="task" value={{...task,delivery:{repository:"taras/executable.md",reviewer:{provider:"claude",model:"fixture",effort:null,session:"independent-review"},acceptance:[{id:"accepted-behavior",source:task.inputs[0],requirement:"Preserve the original accepted behavior."}]}}} />
<Let as="checkoutCase" value={["sibling","outside","outside-error","alias"].includes(scenario)} />
<If condition={checkoutCase}>
```bash exec as="layout"
set -e
git -C repository worktree add --quiet --detach ../sibling HEAD
mkdir outside outside-error
ln -s repository alias
```
<AssertEquals actual={layout.exitCode} expected={0} />
<Let as="task" value={{...task,request:"unanswered-plan-decision",providers:{...task.providers,planner:"codex"},scope:{...task.scope,implementation:{...task.scope.implementation,ready:false}}}} />
</If>
<Let as="launchDirectory" value={checkoutCase ? fixture.root + "/" + scenario : fixture.repository} />
<Let as="bad" value={scenario === "unselected" ? {...task,scope:{...task.scope,sharedApi:{needed:false,evidence:[fixture.root + "/unselected.md"]}}} : scenario === "missing-evidence" ? {...task,inputs:[evidence,fixture.root + "/missing.md"]} : scenario === "revision" ? {...task,revision:"0".repeat(40)} : scenario === "sessions" ? {...task,sessions:{...task.sessions,planner:task.sessions.implementor}} : scenario === "policy" ? {...task,assessment:{...assessment,mechanical:true}} : scenario === "missing-source" ? {...task,repository:fixture.root + "/absent-repository"} : task} />
<If condition={scenario === "dirty"}><Dir path={fixture.repository}><File path="legacy.fixture">Uncommitted partial source.</File></Dir></If>
<If condition={scenario === "occupied"}><Dir path={fixture.directory}><File path="keep.txt">Preserve this existing record.</File></Dir></If>
<If condition={scenario === "outside" || scenario === "outside-error"}>
<Let as="fakeRoot" value={"'" + fixture.root.replaceAll("'","'\"'\"'") + "'"} />
```bash exec as="fakeGit"
set -e
cd -- {fakeRoot}
mkdir -p bin
cat > bin/git <<'GIT'
#!/bin/bash
if [[ $# = 2 && "$1 $2" = "rev-parse --show-toplevel" ]]; then
  if [[ "${PWD##*/}" = outside-error ]]; then
    echo 'fatal: fixture query failed' >&2
    exit 129
  fi
  if [[ "${LC_ALL:-}" = C ]]; then
    echo 'fatal: not a git repository' >&2
  else
    echo 'fatal : ceci ne semble pas être un dépôt git' >&2
  fi
  exit 128
fi
exec "$XMD_G6_REAL_GIT" "$@"
GIT
chmod +x bin/git
```
<AssertEquals actual={fakeGit.exitCode} expected={0} />
<Let as="bin" value={"'" + (fixture.root + "/bin").replaceAll("'","'\"'\"'") + "'"} />
<Fixture.Entry entry="run" value={bad} repository={launchDirectory} command={"XMD_G6_REAL_GIT=$(command -v git) LC_ALL=POSIX PATH=" + bin + ":\"$PATH\" " + runner} root={root} as="child" />
<Else>
<If condition={scenario === "missing-task"}>
<Fixture.Entry entry="run" value={bad} repository={fixture.repository} taskPath={scenario === "missing-task" ? fixture.root + "/absent-task.json" : null} command={runner} root={root} as="child" />
<Else>
<Fixture.Execution entry="run" value={bad} repository={launchDirectory} root={root} as="child" />
</Else>
</If>
</Else>
</If>
<If condition={scenario === "outside-error"}>
<AssertEquals actual={child.exitCode !== 0} expected={true} />
<AssertStringIncludes actual={child.stderr} expected="fixture query failed" />
<Else>
<If condition={child.exitCode !== 0}><Fail message={scenario + ": " + child.stderr + child.stdout} /></If>
<Parse schema={{type:"object"}} as="held">{child.stdout}</Parse>
<AssertEquals actual={held.status} expected="hold" />
<If condition={scenario === "alias"}>
<Ticket.Load record={held} as="routed" />
<AssertEquals actual={routed.calls.map(call => call.role)} expected={["planner"]} />
<AssertStringIncludes actual={routed.checkpoint.hold.reason} expected="material choice" />
<Else>
<AssertEquals actual={held.history} expected={[]} />
<If condition={checkoutCase}>
<AssertStringIncludes actual={held.reason} expected={fixture.repository} />
<AssertStringIncludes actual={held.reason} expected={launchDirectory} />
<Dir path={fixture.root}>
```bash exec as="absentWork"
test ! -e work && test ! -e work.inputs
```
</Dir>
<AssertEquals actual={absentWork.exitCode} expected={0} />
<Else>
<AssertStringIncludes actual={held.reason} expected={scenario === "unselected" ? "unselected.md" : scenario === "missing-evidence" ? "missing.md" : scenario === "missing-task" ? "absent-task.json" : scenario === "oversized" ? "64000" : scenario === "revision" || scenario === "dirty" ? "Source" : scenario === "sessions" ? "sessions" : scenario === "policy" ? "mechanical" : scenario === "missing-source" ? "absent-repository" : "occupied"} />
</Else></If>
<Dir path={fixture.root}><Glob include={["**/called.json"]} as="calls" /></Dir>
<AssertEquals actual={calls} expected={[]} />
<If condition={scenario === "occupied"}><Ticket.Text path={fixture.directory + "/keep.txt"} as="kept" /><AssertEquals actual={kept} expected="Preserve this existing record." /></If>
<If condition={scenario === "missing-source"}><Dir path={fixture.root}><Glob include={["absent-repository/**"]} as="created" /></Dir><AssertEquals actual={created} expected={[]} />
<Let as="missingPath" value={"'" + bad.repository.replaceAll("'","'\"'\"'") + "'"} />
```bash exec as="absent"
test -d {missingPath}
```
<AssertEquals actual={absent.exitCode} expected={1} />
</If>
</Else></If>
</Else>
</If>
</TempDir>
</Each>
</Test>
