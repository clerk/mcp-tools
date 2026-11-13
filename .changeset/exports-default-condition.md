---
'@clerk/mcp-tools': patch
---

Every subpath in the `exports` map has a `default` condition, pointing at the same ES module as `import`, so `require('@clerk/mcp-tools/server')` loads it through `require(esm)` (Node.js 20.19, 22.12, and later), and CommonJS-condition resolvers find it. The package is still ESM-only.
