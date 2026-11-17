# Dolibarr MCP Server module

This Dolibarr module bundles the
[Dolibarr MCP Server](https://github.com/frankiewonghk/dolibarr-mcp-server),
a Model Context Protocol (MCP) server that lets AI assistants such as Claude
look up and work with Dolibarr data through the REST API.

Enabling the module:

- enables Dolibarr's **API REST** module, which the server needs;
- adds a setup page (*Home → Setup → Modules → Dolibarr MCP Server*) that
  checks your instance and gives installation instructions with the right
  `DOLIBARR_URL`.

The MCP server itself is a Node.js program (Node.js 22.13 or later) found in
the `mcp-server` folder. Copy it outside the web root, run
`npm ci --omit=dev`, and add it to your MCP client. See `mcp-server/README.md`
for full instructions, including the team (HTTP with OAuth) mode.

Licence: MIT (compatible with GPL v3).
