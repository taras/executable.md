# Third-party notices

`@executablemd/acp` embeds third-party source. The notices below travel with
every published artifact, because bundling code does not bundle away its
license.

## acpx

The ACP runtime under `vendor/acpx/generated` is npm `acpx@0.12.0`, carried in
source with one local patch. `vendor/acpx/PROVENANCE.md` states the patch, the
upstream release commit it is taken from, and why it exists. dnt inlines this
closure into the npm artifact, so the notice belongs with it.

The snapshot is carried by issue #519 and removed by issue #526, once a
released upstream package set provides the transient agent-environment input
the patch supplies and passes #526's stated removal gate. Until then the patch
is maintained here rather than upstreamed piecemeal.

- Project: <https://github.com/openclaw/acpx>
- Copyright (c) 2025 OpenClaw Team
- License: MIT

```text
MIT License

Copyright (c) 2025 OpenClaw Team

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
