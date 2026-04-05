# agents

Small repo for two things:

- Codex plugins under `plugins/`
- installable Pi resources under `extensions/`

## Pi package

This repo is also a minimal Pi package, so you can install it directly from git:

```bash
pi install git:github.com/matixlol/agents
```

Or try it without installing:

```bash
pi -e git:github.com/matixlol/agents
```

For the Codex fast extension specifically:

```bash
pi -e git:github.com/matixlol/agents --codex-fast --model openai-codex/gpt-5.4-mini
# or, after installing the package once:
pi --model openai-codex/gpt-5.4-mini
```

Currently included Pi extension:

- `codex-fast-mode`: experimental `openai-codex` request patch that injects `service_tier: "priority"`, remembers the last enabled/tier state across Pi runs, and shows `fast:priority` in Pi's footer

Extension docs:

- `docs/codex-fast-mode/README.md`

## Codex plugins

Currently included:

- `ahrefs-mcp`: a minimal Codex plugin that exposes Ahrefs' hosted MCP server and a small Ahrefs skill

## Layout

- `package.json`: Pi package manifest for git installs
- `extensions/`: Pi extensions loaded by the package
- `docs/`: extension docs
- `.agents/plugins/marketplace.json`: repo-local marketplace entry for Codex
- `plugins/ahrefs-mcp/`: the Ahrefs Codex plugin itself

## Included plugin

The Ahrefs plugin is intentionally narrow:

- hosted Ahrefs MCP server URL only
- one small Ahrefs skill
- no extra apps, hooks, or compatibility shims

## Sources

- OpenAI Docs MCP guide: <https://developers.openai.com/learn/docs-mcp>
- Ahrefs MCP introduction: <https://docs.ahrefs.com/mcp/docs/introduction>
- Ahrefs Claude Code setup: <https://docs.ahrefs.com/mcp/docs/claude-code>
