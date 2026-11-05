<Test name="first File text, protected recovery and joined reader cleanup" timeout="110s">
<TempDir><Fixture.Repository as="fixture" /><Dir path={fixture.repository}><Fixture.ArtifactReturn fixture={fixture} recovery={true} /></Dir></TempDir>
</Test>
