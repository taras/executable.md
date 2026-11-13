```bash exec as="location"
pwd -P
```
<Let as="root" value={location.stdout.trim()} />

<Test name="A1 A2 A4 ordinary discovery uses original owners and stops on refused dispositions" timeout="120s">
<Fixture.InitialPlanning root={root} />
</Test>
