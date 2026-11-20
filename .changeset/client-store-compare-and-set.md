---
'@clerk/mcp-tools': minor
---

Add an optional `compareAndSet(key, expected, value)` method to `McpClientStore`, and implement it in the Redis, Postgres and SQLite stores. When a store has it, the client saves a session only if it is unchanged since the save read it, and otherwise reads it and checks the authorization server binding again. Two processes saving the same session at once, such as two OAuth callbacks or token refreshes, can then no longer both bind it: the later save is rejected for an issuer other than the one the earlier save bound, and overlapping saves for the same issuer keep both changes. A save that loses to other saves 10 times in a row throws. Custom stores without `compareAndSet` keep working as before, reading and then writing the session, which leaves that race open; the file system store, meant for development, has no `compareAndSet`.
