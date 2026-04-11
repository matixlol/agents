# Observable notebook MCP server

Small stdio MCP server for reading and editing Observable notebooks directly through Observable's internal document API.

## Run

From the `agents` repo root:

```bash
bun run ./plugins/observablehq-mcp/server/observable-notebook-mcp.ts
```

## Required env for writes

Read operations work on public/unlisted notebooks without auth.

Write operations require an authenticated Observable cookie header:

```bash
export OBSERVABLE_COOKIE='D=...; T=...; I=...; ...'
```

The easiest way to get this is to copy the full `Cookie` request header from an authenticated request to `observablehq.com` / `api.observablehq.com` in your browser DevTools.

## MCP config example

Machine-independent config using the git repo:

```json
{
  "mcpServers": {
    "observablehq": {
      "command": "npx",
      "args": ["-y", "github:matixlol/agents"],
      "env": {
        "OBSERVABLE_COOKIE": "D=...; T=...; I=..."
      }
    }
  }
}
```

`bunx --package=github:matixlol/agents observablehq-mcp` works too.

Local checkout alternative:

```json
{
  "mcpServers": {
    "observablehq": {
      "command": "bun",
      "args": ["run", "./plugins/observablehq-mcp/server/observable-notebook-mcp.ts"]
    }
  }
}
```

## Tools

- `observable_get_notebook`
- `observable_list_cells` (`includeCode: true` to include full source)
- `observable_find_cells`
- `observable_get_cell`
- `observable_get_cells`
- `observable_set_cell`
- `observable_replace_in_cell`

## Notes

- Cell selection supports exactly one of `nodeId`, `name`, or `index`.
- For public notebooks, explicit Observable cell names are not always returned by the API, so the server also infers names from cell source when possible.
- Writes go through Observable's websocket edit protocol and return the resulting `version` + `subversion` after `saveconfirm`.
