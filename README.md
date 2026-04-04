# agents

Minimal Codex plugin repo for hosted MCP integrations.

Currently included:

- `ahrefs-mcp`: a minimal Codex plugin that exposes Ahrefs' hosted MCP server and a small Ahrefs skill

## Layout

- `.agents/plugins/marketplace.json`: repo-local marketplace entry for Codex
- `plugins/ahrefs-mcp/`: the Ahrefs plugin itself

## Included plugin

The Ahrefs plugin is intentionally narrow:

- hosted Ahrefs MCP server URL only
- one small Ahrefs skill
- no extra apps, hooks, or compatibility shims

## Sources

- OpenAI Docs MCP guide: <https://developers.openai.com/learn/docs-mcp>
- Ahrefs MCP introduction: <https://docs.ahrefs.com/mcp/docs/introduction>
- Ahrefs Claude Code setup: <https://docs.ahrefs.com/mcp/docs/claude-code>
