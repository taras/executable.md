<Test name="includes replace defaults in order and completed entries retain their source and output" timeout="90s">
  <TempDir>
    <Cwd as="root" />
    <Dir path="first">
      <File path="Greeting.md">First greeting rendered.</File>
      <Let as="external" select="code">
```xmd
<File path="witness.txt">first-write</File>

External-only rendered.
```
      </Let>
      <File path="ExternalOnly.md">{external}</File>
    </Dir>
    <Dir path="second">
      <File path="Greeting.md">Second greeting rendered.</File>
    </Dir>
    <Dir path="components"><File path="WorkspaceOnly.md">Local default rendered.</File></Dir>
    <File path="RootOnly.md">Root default rendered.</File>
    <Let as="includes" value={["first",root+"/second"]} />

    <ReplBench include={includes} expectExit={true} as="closed">
      <ReplBench.Type text={"<Greeting />\n<ExternalOnly />"} />
      <ReplBench.WaitForText text="<ExternalOnly />" />
      <ReplBench.Key key="Enter" />
      <ReplBench.WaitForText text="Ready for Entry 2" />
      <ReplBench.WaitForText text="First greeting rendered." />
      <ReplBench.WaitForText text="External-only rendered." />
      <ReplBench.WaitForText text="Second greeting rendered." present={false} />

      <ReplBench.Type text="<WorkspaceOnly />" />
      <ReplBench.WaitForText text="<WorkspaceOnly />" />
      <ReplBench.Key key="Enter" />
      <ReplBench.WaitForText text="Cannot resolve component: WorkspaceOnly" />
      <ReplBench.WaitForText text="Local default rendered." present={false} />
      <Each in={"<WorkspaceOnly />".split("")} let="character"><ReplBench.Key key="Backspace" /></Each>
      <ReplBench.WaitForText text="<WorkspaceOnly />" present={false} />

      <ReplBench.Type text="<RootOnly />" />
      <ReplBench.WaitForText text="<RootOnly />" />
      <ReplBench.Key key="Enter" />
      <ReplBench.WaitForText text="Cannot resolve component: RootOnly" />
      <ReplBench.WaitForText text="Root default rendered." present={false} />
      <Each in={"<RootOnly />".split("")} let="character"><ReplBench.Key key="Backspace" /></Each>
      <ReplBench.WaitForText text="<RootOnly />" present={false} />
      <ReplBench.WaitForText text="Ready for Entry 2" />
      <ReplBench.Key key="Ctrl+C" />
    </ReplBench>
    <AssertEquals actual={closed.exitCode} expected={0} />
    <File path="witness.txt" as="written" />
    <AssertEquals actual={written} expected="first-write" />
    <File path="witness.txt">external edit survives</File>
    <Dir path="first">
      <File.Delete path="Greeting.md" />
      <File.Delete path="ExternalOnly.md" />
    </Dir>
    <Dir path="second"><File.Delete path="Greeting.md" /></Dir>

    <ReplBench resume={closed.resume} include={includes} expectExit={true} as="reopened">
      <ReplBench.WaitForText text="Ready for Entry 2" />
      <ReplBench.WaitForText text="First greeting rendered." />
      <ReplBench.WaitForText text="External-only rendered." />
      <ReplBench.WaitForText text="Source" />
      <ReplBench.WaitForText text="<Greeting />" />
      <ReplBench.WaitForText text="<ExternalOnly />" />
      <ReplBench.Key key="Ctrl+C" />
    </ReplBench>
    <AssertEquals actual={reopened.exitCode} expected={0} />
    <File path="witness.txt" as="retained" />
    <AssertEquals actual={retained} expected="external edit survives" />

    <Dir path="first"><File path="Greeting.md">First greeting rendered.</File></Dir>
    <Dir path="second"><File path="Greeting.md">Second greeting rendered.</File></Dir>
    <ReplBench include={[root+"/second","first"]}>
      <ReplBench.Type text="<Greeting />" />
      <ReplBench.WaitForText text="<Greeting />" />
      <ReplBench.Key key="Enter" />
      <ReplBench.WaitForText text="Ready for Entry 2" />
      <ReplBench.WaitForText text="Second greeting rendered." />
      <ReplBench.WaitForText text="First greeting rendered." present={false} />
    </ReplBench>

    <ReplBench>
      <ReplBench.Type text={"<WorkspaceOnly />\n<RootOnly />"} />
      <ReplBench.WaitForText text="<RootOnly />" />
      <ReplBench.Key key="Enter" />
      <ReplBench.WaitForText text="Ready for Entry 2" />
      <ReplBench.WaitForText text="Local default rendered." />
      <ReplBench.WaitForText text="Root default rendered." />
    </ReplBench>
  </TempDir>
</Test>

<Each in={["unchanged","reassigned","omitted"]} let="mode">
<Test name={"mounted reads replay and new work follows the "+mode+" placement"} timeout="90s">
  <TempDir>
    <Cwd as="root" />
    <Dir path="fixtures"><File path="read.md">mounted fixture</File></Dir>
    <Dir path="old">
      <File path="read.md">historical</File>
      <File path="next.md">old frontier</File>
    </Dir>
    <Dir path="new">
      <File path="read.md">current</File>
      <File path="next.md">new frontier</File>
    </Dir>
    <Dir path="reference">
      <File path="read.md">current</File>
      <File path="next.md">ordinary frontier</File>
    </Dir>
    <Let as="target" value={root+"/reference"} />
    <Let as="selected" value={mode==="unchanged"?"old":mode==="reassigned"?"new":"reference"} />
    <Let as="frontier" value={mode==="unchanged"?"old frontier":mode==="reassigned"?"new frontier":"ordinary frontier"} />
    <Let as="fixtureTarget" value={root+"/fixture-reference"} />
    <Let as="fixtureMount" value={"fixtures:"+fixtureTarget} />
    <Let as="initialMounts" value={["old:"+target,fixtureMount]} />
    <Let as="currentMounts" value={mode==="omitted"?[]:[selected+":"+target,fixtureMount]} />
    <Let as="path" value={JSON.stringify(target)} />
    <Let as="fixtureBody" select="code">
```xmd
<File path="read.md" as="fixture" />
<File path="used.md">{fixture}</File>
```
    </Let>
    <Let as="body" select="code">
````xmd
<File path="read.md" as="saved" />

```sh exec
pwd -P | tr -d '\n' > process-cwd.txt
```

<Elicit schema={{type:"object",properties:{decision:{type:"string",enum:["continue"]}},required:["decision"],additionalProperties:false}} as="answer">Saved {saved}. Continue?</Elicit>
<File path="next.md" as="current" />
<File path="result.md">{saved}|{current}</File>
````
    </Let>
    <ReplBench mount={initialMounts} allowAbsolute={true} expectExit={true} as="held">
      <ReplBench.Type text={"<Dir path="+JSON.stringify(fixtureTarget)+">\n"+fixtureBody+"\n</Dir>\n\n<Dir path="+path+">\n"+body+"\n</Dir>"} />
      <ReplBench.WaitForText text="</Dir>" />
      <ReplBench.Key key="Enter" />
      <ReplBench.WaitForText text="waiting for an answer" />
      <ReplBench.WaitForText text="[exit]" as="exit" />
      <ReplBench.Click at={exit} />
    </ReplBench>
    <AssertEquals actual={held.exitCode} expected={0} />
    <Dir path="fixtures">
      <File path="used.md" as="used" />
      <AssertEquals actual={used} expected="mounted fixture" />
    </Dir>
    <Dir path="old">
      <File path="process-cwd.txt" as="commandCwd" />
      <AssertEquals actual={commandCwd} expected={root+"/old"} />
      <File path="process-cwd.txt">external edit survives</File>
      <File path="read.md">changed</File>
    </Dir>

    <ReplBench resume={held.resume} mount={currentMounts} allowAbsolute={true} expectExit={true} as="finished">
      <ReplBench.WaitForText text="waiting for an answer" />
      <ReplBench.WaitForText text="[answer]" as="answer" />
      <ReplBench.Click at={answer} />
      <ReplBench.WaitForText text="Saved historical." />
      <ReplBench.WaitForText text="( ) continue" as="continueChoice" />
      <ReplBench.Click at={continueChoice} />
      <ReplBench.WaitForText text="Ready for Entry 2" />
      <ReplBench.WaitForText text="[exit]" as="exit" />
      <ReplBench.Click at={exit} />
    </ReplBench>
    <AssertEquals actual={finished.exitCode} expected={0} />
    <Dir path={selected}>
      <File path="result.md" as="result" />
      <AssertEquals actual={result} expected={"historical|"+frontier} />
      <If condition={selected!=="old"}>
        <Glob include={["process-cwd.txt"]} as="replayed" />
        <AssertEquals actual={replayed} expected={[]} />
      </If>
    </Dir>
    <Dir path="old">
      <File path="process-cwd.txt" as="retainedCwd" />
      <AssertEquals actual={retainedCwd} expected="external edit survives" />
    </Dir>

    <ReplBench resume={finished.resume} mount={currentMounts} allowAbsolute={true} expectExit={true} as="freshSession">
      <ReplBench.WaitForText text="Ready for Entry 2" />
      <Let as="freshBody" select="code">
```xmd
<File path="read.md" as="fresh" />
<File path="fresh.md">{fresh}</File>

fresh is {fresh}
```
      </Let>
      <ReplBench.Type text={"<Dir path="+path+">\n"+freshBody+"\n</Dir>"} />
      <ReplBench.WaitForText text="</Dir>" />
      <ReplBench.Key key="Enter" />
      <ReplBench.WaitForText text="Ready for Entry 3" />
      <ReplBench.WaitForText text="Entries" row={1} as="catalog" />
      <ReplBench.Click at={catalog} />
      <ReplBench.WaitForText text="2. [ok]" as="entry" />
      <ReplBench.Click at={entry} />
      <ReplBench.WaitForText text={selected==="old"?"fresh is changed":"fresh is current"} />
      <ReplBench.WaitForText text="[exit]" as="exit" />
      <ReplBench.Click at={exit} />
    </ReplBench>
    <AssertEquals actual={freshSession.exitCode} expected={0} />
    <Dir path={selected}>
      <File path="fresh.md" as="fresh" />
      <AssertEquals actual={fresh} expected={selected==="old"?"changed":"current"} />
    </Dir>
  </TempDir>
</Test>
</Each>
