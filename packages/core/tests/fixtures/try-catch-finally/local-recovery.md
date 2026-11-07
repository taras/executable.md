<Let as="error" value="outer" />
<Let as="captured">
<Try>
<Let as="completed" value="body" />
Prefix.
```sh exec
FAIL
```
Unreachable.
<Catch as="error">
Recovered: {error.message}
<Let as="local" value="catch" />
</Catch>
<Finally>
<Let as="finished" value="finally" />
Completion.
</Finally>
</Try>
</Let>
{captured}
{error}: {completed}: {finished}
