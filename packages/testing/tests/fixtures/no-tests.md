# A document with nothing to test

This fixture exists so `xmd test` has a document that contains no `<Test>`
region and no executable block, and is guaranteed to keep containing neither.

Ordinary prose, a list, and an inert code fence are all it holds:

- a bullet,
- another bullet.

```bash
echo "this fence is an example, not an executable block"
```
