<Test name="bounded artifact growth and saturation" timeout="110s">
<TempDir><Fixture.Repository as="fixture" /><Dir path={fixture.repository}><Fixture.ArtifactReturn fixture={fixture} /></Dir></TempDir>
</Test>

<Test name="migration repair uses retained result after original mutation or removal and holds on missing snapshot" timeout="100s">
<Each in={["changed","removed","missing"]} let="mode">
<TempDir><Fixture.Repository as="fixture" /><Dir path={fixture.repository}><Fixture.RetainedRepair fixture={fixture} mode={mode} /></Dir></TempDir>
</Each>
</Test>
