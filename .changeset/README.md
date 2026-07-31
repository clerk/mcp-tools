# Changesets

This directory contains release notes for `@clerk/mcp-tools`. Add one with
`pnpm changeset`; use `pnpm changeset:empty` when a change should not publish a
new package version.

The release workflow turns pending changesets into a version PR. Merging that
PR publishes the package and its corresponding Git tag.
