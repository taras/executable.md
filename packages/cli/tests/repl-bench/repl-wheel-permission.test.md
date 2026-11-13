<Test name="Permission wheel preserves focus and keyboard reaches the final choice" timeout="60s">
  <ReplBench columns={120} rows={30} entryPermissionFixture={true}>
    <ReplBench.Type text={'<AgentProvider name="wheel-permission-fixture" defaultAgent="fixture"><Session name="permission"><Prompt text="many choices" /></Session></AgentProvider>'} />
    <ReplBench.WaitForText text="many choices" />
    <ReplBench.Key key="Enter" />
    <ReplBench.WaitForText text="asks: Permission prose 00" as="permission" />
    <ReplBench.Click at={permission} />
    <ReplBench.WaitForText text="> [Choice 00]" as="first" />
    <ReplBench.WaitForText text="Permission prose 44" present={false} />
    <ReplBench.Scroll delta={8} at={first} />
    <ReplBench.WaitForText text="> [Choice 00]" at={first} />
    <Each in={Array.from({length:39},(_,step)=>step+1)} let="choice">
      <ReplBench.Key key="ArrowDown" />
      <ReplBench.WaitForText text={"> [Choice "+String(choice).padStart(2,"0")+"]"} />
    </Each>
    <Each in={Array.from({length:39},(_,step)=>38-step)} let="choice">
      <ReplBench.Key key="ArrowUp" />
      <ReplBench.WaitForText text={"> [Choice "+String(choice).padStart(2,"0")+"]"} />
    </Each>
    <Each in={[1,2,3,4,5,6,7,8]} let="page">
      <ReplBench.Key key="PageUp" />
    </Each>
    <ReplBench.WaitForText text="Permission prose 01" as="prose" />
    <ReplBench.WaitForText text="Permission prose 00" at={{row:prose.row-1,column:prose.column}} />
    <ReplBench.Scroll delta={1} at={prose} />
    <ReplBench.WaitForText text="Permission prose 01" at={prose} present={false} />
    <ReplBench.WaitForText text="Permission prose 03" />
    <ReplBench.Scroll delta={-1} at={prose} />
    <ReplBench.WaitForText text="Permission prose 01" at={prose} />
    <ReplBench.WaitForText text="Permission prose 00" at={{row:prose.row-1,column:prose.column}} />
    <Each in={[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16]} let="page">
      <ReplBench.Key key="PageDown" />
    </Each>
    <ReplBench.WaitForText text="[Choice 39]" as="last" />
    <ReplBench.WaitForText text="[close]" />
    <ReplBench.WaitForText text="Permission prompt completed." present={false} />
    <Each in={[1,2,3,4,5,6,7,8]} let="page">
      <ReplBench.Key key="PageUp" />
    </Each>
    <ReplBench.WaitForText text="Permission prose 01" at={prose} />
    <ReplBench.WaitForText text="Permission prose 00" at={{row:prose.row-1,column:prose.column}} />
    <ReplBench.WaitForText text="[Choice 00]" present={false} />
    <ReplBench.WaitForText text="[Choice 39]" present={false} />
    <ReplBench.WaitForText text="[↑ earlier]" present={false} />
    <ReplBench.WaitForText text="[↓ later]" present={false} />
    <ReplBench.WaitForText text="[Scroll up]" present={false} />
    <ReplBench.WaitForText text="[Scroll down]" present={false} />
    <Each in={[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16]} let="page">
      <ReplBench.Key key="PageDown" />
    </Each>
    <ReplBench.WaitForText text="[Choice 39]" at={last} />
    <ReplBench.Click at={last} />
    <ReplBench.WaitForText text="Permission prompt completed." />
    <ReplBench.WaitForText text="✓ COMPLETED" />
    <ReplBench.WaitForText text="Ready for Entry 2" />
    <ReplBench.WaitForText text="Expected one prompt and exactly one decision selecting Choice 39." present={false} />
  </ReplBench>
</Test>
