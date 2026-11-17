# Security policy

## Reporting a vulnerability

Please do not open a public issue for security problems. Report them
privately through GitHub's
[security advisory form](https://github.com/frankiewonghk/dolibarr-mcp-server/security/advisories/new).
Include a description, steps to reproduce and the affected version. You will
receive an acknowledgement, and a fix will be prepared and released before the
issue is disclosed.

## Scope

In scope: this server's own code — the OAuth sign-in and token handling, the
storage of API keys, the confirmation guard on irreversible tools, and the
generic API tools.

Out of scope: vulnerabilities in Dolibarr itself (report those to the
[Dolibarr project](https://github.com/Dolibarr/dolibarr/security)) and in the
MCP clients that connect to the server.

## Hardening recommendations

- Publish HTTP mode only over HTTPS, behind a reverse proxy, with the service
  listening on `127.0.0.1`.
- Keep `MCP_SECRET_KEY` and the settings file readable by the service owner
  only.
- Give automated agents dedicated Dolibarr users with minimal permissions.
- Use `DOLIBARR_WRITE_MODE=off` for instances that should only be queried.
