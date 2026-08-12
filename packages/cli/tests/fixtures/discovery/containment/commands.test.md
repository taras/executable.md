# Commands

A command that exits nonzero inside a test is that test's outcome, not the
document's: the test after it still runs, and `xmd test` decides the run.

<Test name="a failing command fails its own test">

```bash exec
printf 'BEFORE_FAILURE\n'; exit 3
```

</Test>

<Test name="the test after it still runs">

```bash exec
printf 'AFTER_CONTAINMENT\n'
```

</Test>
