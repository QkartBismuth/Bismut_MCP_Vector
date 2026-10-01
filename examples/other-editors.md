# Other editors

Any MCP client that speaks stdio and reads a JSON config can use this server.
The two shapes below cover most editors.

## Cursor / Windsurf / Zed / Continue / Trae / Void

These use a `mcpServers` object identical to Claude Code:

```json
{
  "mcpServers": {
    "bismut-vector": {
      "command": "node",
      "args": ["/absolute/path/to/Bismut_MCP_Vector/dist/index.js"],
      "env": {
        "BISMUT_DB_PATH": "/absolute/path/to/Bismut_MCP_Vector/.bismut/vectors.db",
        "BISMUT_COLLECTION": "myproject"
      }
    }
  }
}
```

Zed uses a nested variant in `settings.json`:

```json
{
  "context_servers": {
    "bismut-vector": {
      "command": {
        "path": "node",
        "args": ["/absolute/path/to/Bismut_MCP_Vector/dist/index.js"],
        "env": {}
      }
    }
  }
}
```

## Hermes and other agent frameworks

Point the framework at the executable and pass environment variables directly.
If the framework expects a single command string rather than `command` + `args`:

```json
{
  "mcpServers": {
    "bismut-vector": {
      "command": "BISMUT_COLLECTION=myproject node /absolute/path/to/Bismut_MCP_Vector/dist/index.js"
    }
  }
}
```

## Verify any client

The server speaks MCP over stdio. A quick handshake check that does not require
an editor:

```powershell
npm run build
node scripts/smoke-test.mjs
```

## Using a global install

```powershell
npm install -g .
bismut-vector-mcp
```

Then reference the command by name in your client config:

```json
{
  "mcpServers": {
    "bismut-vector": { "command": "bismut-vector-mcp" }
  }
}
```