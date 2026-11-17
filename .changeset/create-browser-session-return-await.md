---
'@clerk/mcp-tools': patch
---

`createBrowserSession` now awaits its request before returning. A refused request (for example a hostile `path`) no longer creates an already-rejected promise that the caller only picks up a microtask later, which runtimes such as workerd report as an unhandled rejection.
