```bash exec as="location"
pwd -P
```
<Let as="root" value={location.stdout.trim()} />
```bash exec as="commandSetting"
printf '%s' "$XMD_EXAMPLE_COMMAND"
```
<Let as="runner" value={commandSetting.stdout || "deno run --node-modules-dir=manual --cached-only --allow-all '" + root.replaceAll("'","'\"'\"'") + "/packages/cli/src/deno.ts' run"} />

<Test name="delivery publishes joined ACP review verdicts and reconciles lost acknowledgements, interruption, and concurrent GitHub writes" timeout="240s">
<Each in={["pass","changes_required","lost","interrupted"]} let="scenario">
<TempDir>
<Fixture.Repository as="fixture" />
<Dir path={fixture.repository}>
```bash exec as="identity"
git rev-parse HEAD
git symbolic-ref --short HEAD
```
<Let as="revision" value={identity.stdout.trim().split("\n")[0]} />
<Let as="branch" value={identity.stdout.trim().split("\n")[1]} />
<Let as="policy" value={{repository:"taras/executable.md",reviewer:{provider:"claude",model:"fable",effort:null,session:"independent"},acceptance:[{id:"behavior",source:"accepted.md",requirement:"Preserve the accepted behavior."}]}} />
<Delivery.Prepare task={{work:"ACP overlap",repository:fixture.repository,directory:fixture.directory,inputs:["accepted.md"],sessions:{planner:"planner",implementor:"implementor",architect:"architect"},delivery:policy}} inputs={[{path:"accepted.md",content:"Preserve the accepted behavior."}]} as="delivery" />
<Dir path={delivery.directory}>
<File path="requirements.json"><Json value={delivery} /></File>
<File path="feedback.json"><Json value={{status:"feedback_ready",revision}} /></File>
</Dir>
<File path="remote.json"><Json value={{revision,branch,base:"main",draft:false,state:"open",merged:false,mergeRevision:null,stable:true,ciGreen:true,ci:{status:"completed",conclusion:"success"},main:{revision,run:{status:"completed",conclusion:"success"}},mainRepair:false}} /></File>
<Fixture.ReviewOverlap command={runner} directory={delivery.directory} revision={revision} scenario={scenario} />
</Dir>
</TempDir>
</Each>
</Test>
