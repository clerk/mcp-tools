---
'@clerk/mcp-tools': patch
---

Fix two Postgres store bugs. `read` now returns a stored string as the string that was written: it no longer throws for a string that isn't JSON text, such as the session id the client stores for each OAuth state, so `completeOAuth` works with the Postgres store again, and it no longer turns a string such as `'123'` or `'true'` into a number or boolean. Stores that start together on a new table no longer fail with a duplicate key error from `CREATE TABLE IF NOT EXISTS`: each one creates the table under an advisory lock for the table name.
