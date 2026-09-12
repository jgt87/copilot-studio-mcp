# Change Log

## 0.1.6

First VS Code packaging of `copilot-studio-mcp`. The extension contributes the server to VS Code's
MCP host; the server itself is unchanged and its history is in the
[repository](https://github.com/jgt87/copilot-studio-mcp/releases).

- Bundles the server and its production dependencies, so the install is offline and version-pinned.
- Settings for the tool preset, read-only mode, the agent workspace, environment defaults, the
  client id and the `pac` auth profiles.
- Runs on `node` from PATH when it is Node 20 or newer, otherwise on the editor's own Node.
