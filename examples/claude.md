# Claude Code

## Per project (recommended)

`.mcp.json` in the repository root:

```json
{
  "mcpServers": {
    "bismut-vector": {
      "command": "node",
      "args": ["/path/to/Bismut_MCP_Vector/dist/index.js"],
      "env": {
        "BISMUT_DB_PATH": "/path/to/Bismut_MCP_Vector/.bismut/vectors.db",
        "BISMUT_COLLECTION": "myproject"
      }
    }
  }
}
```

## For all projects on this machine

```powershell
claude mcp add bismut-vector --scope user `
  -- node /path/to/Bismut_MCP_Vector/dist/index.js
```

Then verify with `claude mcp list`.

## From Claude Desktop

`%APPDATA%\Claude\claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "bismut-vector": {
      "command": "node",
      "args": ["/path/to/Bismut_MCP_Vector/dist/index.js"],
      "env": {
        "BISMUT_DB_PATH": "~/.bismut/vectors.db",
        "BISMUT_COLLECTION": "notes"
      }
    }
  }
}
```