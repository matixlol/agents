# ahrefs-mcp

Minimal repo-local Codex plugin for Ahrefs.

## What it adds

- the hosted Ahrefs MCP server at `https://api.ahrefs.com/mcp/mcp`
- one small Ahrefs skill under `skills/ahrefs/`

## Notes

- Ahrefs documents the hosted MCP server as available on paid plans starting from Lite.
- Ahrefs uses an authorization flow that creates an MCP-scoped key after consent.
- The plugin keeps the scope narrow on purpose.
