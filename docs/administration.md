# Administration

Day-to-day running of a server in HTTP mode. Installation is described in
[deployment.md](deployment.md).

The admin commands below are shown as `dolibarr-mcp-admin`, the wrapper
installed by the systemd setup. Elsewhere, run them as
`node dist/index.js <command>` with the same environment as the service.

## Access model

The server adds no permissions of its own. Every call is made with the
connected user's Dolibarr API key, so a person can do through the server
exactly what their Dolibarr user can do in the web interface, with two
additional limits:

- a read-only connection has no tools that change data;
- steps that cannot simply be undone need the user's confirmation in the
  conversation.

## Giving a person access

1. **Dolibarr user** with the permissions their job requires.
2. **API key** on the user card (*Generate* next to the API key field). A user
   who may edit their own user gets one automatically at first sign-in.
3. **Connector** in their MCP client, pointing to `https://<host>/mcp`.
4. **Sign-in** on the server's sign-in page with their Dolibarr login and
   password. Unticking *Allow it to create and change records* gives a
   read-only connection.

A sign-in stays valid for `MCP_REFRESH_TTL_DAYS` (default 30) days of
inactivity; the client renews it while it is in use.

## Giving an automated agent access

An agent that runs without a person (a scheduled job, a workflow tool) uses a
long-lived token instead of the sign-in page.

1. Create a **dedicated Dolibarr user** for the agent with only the permissions
   the job requires, and generate its API key.
2. Create the token. The command asks for that API key (or reads it from
   standard input) and prints the token once:

   ```bash
   dolibarr-mcp-admin token create --label "nightly stock report" --scope read --days 90
   ```

3. Configure the agent with the server's `/mcp` URL and the header
   `Authorization: Bearer <token>`.

Use `--scope write` only for an agent that must change data. An unattended
agent has nobody to confirm guarded steps and will set `confirm` itself, so its
Dolibarr permissions are the effective limit: keep them narrow. Tokens expire
after `--days` (at most 366).

## Connections and audit log

```bash
dolibarr-mcp-admin token list
```

Lists sign-ins and tokens that are still valid: id, Dolibarr login, scope,
expiry and the client name or label.

```bash
dolibarr-mcp-admin audit 100
```

Shows the most recent tool calls: time (UTC), Dolibarr login, outcome, tool and
arguments. Guarded steps include the `reason` given. Secrets are masked. The
log is kept for `MCP_AUDIT_KEEP_DAYS` (default 365) days.

Dolibarr's own history (agenda events, stock movements) records the changes as
well, under the person's Dolibarr user.

## Revoking access

| Situation | Action |
|---|---|
| One connection must stop | `dolibarr-mcp-admin token revoke <id>` |
| A person leaves, or a device is lost | `dolibarr-mcp-admin token revoke-user <login>`, and disable the user in Dolibarr |
| An agent's token leaked | Revoke it, and regenerate the API key of its Dolibarr user |
| Stop all changes immediately | Set `DOLIBARR_WRITE_MODE=off` and restart the service. Look-ups keep working. |
| Stop everything | Stop the service |

Disabling a user in Dolibarr, or regenerating their API key, stops their
connections at once, because every call uses that key.

## Several Dolibarr instances

One installation serves one Dolibarr instance. For several instances, run one
service per instance, each with its own settings file, port, database file,
public host name and `MCP_SECRET_KEY`. Give each a distinct `DOLIBARR_NAME`
(for example "Production" and "Test") so users can tell them apart.

## Troubleshooting

| Symptom | Likely cause | Check |
|---|---|---|
| The client cannot connect | Service down, or reverse proxy not configured | `curl -s https://<host>/healthz` |
| "The login or password is not correct" | Wrong credentials, or the user is disabled | Try the same login in the Dolibarr web interface |
| "Your Dolibarr user has no API key yet" | No key on the user card, and the user may not edit their own user | Generate the key on the user card |
| "Too many failed attempts" | Five failed sign-ins for that login within 15 minutes | Wait 15 minutes, or restart the service |
| "Sign-in through the API is switched off" | `API_DISABLE_LOGIN_API` is set in Dolibarr | Remove the constant |
| Every tool answers that the sign-in is no longer valid | The user's API key was regenerated or the user disabled | Connect again |
| A tool reports that a right is missing | The Dolibarr user lacks the permission | Grant it in Dolibarr if appropriate |
| Only look-up tools are offered | Read-only sign-in, a `read` token, or `DOLIBARR_WRITE_MODE=off` | `dolibarr-mcp-admin token list` shows the scope |
| A toolset is missing | Not listed in `DOLIBARR_TOOLSETS` | The settings file |

The service log (`journalctl -u dolibarr-mcp`) records each sign-in and failed
attempt, and requests the MCP endpoint refused.

## Security notes

- The sign-in page is the only place a password is entered. Dolibarr checks it;
  the server does not store it. The page names the application that is asking
  and where it will return to.
- Tokens are stored as hashes and API keys encrypted, so a copy of the database
  file alone gives no access. The settings file holds the encryption key: keep
  it readable by root only.
- Any MCP client can register itself and send a user to the sign-in page, as
  the MCP authorization specification intends. Access still requires a valid
  Dolibarr login and is limited to that user's permissions.
