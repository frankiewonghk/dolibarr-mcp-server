# Deployment

This guide installs the server in **HTTP mode** for a team: a service that
users connect to from their MCP client and sign in to with their Dolibarr
login. For a single user on their own computer, **stdio mode** is simpler; see
the [README](../README.md#quick-start-local-stdio).

## Before you start

- **Dolibarr.** The *API REST* module is enabled and the constant
  `API_DISABLE_LOGIN_API` is not set (sign-in uses Dolibarr's
  `POST /api/index.php/login`).
- **API keys.** Each person who will sign in has an API key on their Dolibarr
  user card, or may edit their own user, in which case Dolibarr creates the key
  at first sign-in.
- **A host name** for the server, e.g. `mcp.example.com`, with a DNS record
  pointing to the machine that runs it, and a TLS certificate for it. The
  server must only be reachable over HTTPS.
- **Node.js 22.13 or later**, or Docker.

The server may run on the same machine as Dolibarr or on another one; it only
needs to reach Dolibarr's address.

## Option A: systemd (Linux)

Commands are for Debian/Ubuntu and run as root.

### 1. Node.js

Install Node.js 22 LTS or later, for example from
[NodeSource](https://github.com/nodesource/distributions) or your
distribution's packages. No compiler is needed: the server has no native
modules (it uses Node's built-in SQLite).

### 2. Service user and folders

```bash
useradd --system --home-dir /var/lib/dolibarr-mcp --shell /usr/sbin/nologin dolibarr-mcp
install -d -m 750 -o root -g dolibarr-mcp /opt/dolibarr-mcp-server
install -d -m 700 -o root -g root /etc/dolibarr-mcp
```

### 3. Code

```bash
git clone https://github.com/frankiewonghk/dolibarr-mcp-server.git /opt/dolibarr-mcp-server
cd /opt/dolibarr-mcp-server
npm ci && npm run build && npm prune --omit=dev
chgrp -R dolibarr-mcp . && chmod -R g+rX,o-rwx .
```

### 4. Settings

Create `/etc/dolibarr-mcp/env` (owner root, mode 600):

```bash
DOLIBARR_URL=https://erp.example.com
DOLIBARR_NAME="Example Company ERP"
DOLIBARR_TOOLSETS=all
DOLIBARR_WRITE_MODE=guarded
MCP_HOST=127.0.0.1
MCP_PORT=3900
MCP_PUBLIC_URL=https://mcp.example.com
MCP_SECRET_KEY=<output of: openssl rand -hex 32>
MCP_DB_PATH=/var/lib/dolibarr-mcp/dolibarr-mcp.sqlite
```

Keep a copy of `MCP_SECRET_KEY` in a safe place. Without it the stored
sign-ins cannot be decrypted and every user has to connect again.

### 5. Service

```bash
cp /opt/dolibarr-mcp-server/deploy/dolibarr-mcp.service /etc/systemd/system/
install -m 755 /opt/dolibarr-mcp-server/deploy/dolibarr-mcp-admin /usr/local/sbin/
systemctl daemon-reload && systemctl enable --now dolibarr-mcp
curl -s http://127.0.0.1:3900/healthz
```

The unit runs the service as an unprivileged user that can write only to
`/var/lib/dolibarr-mcp`.

### 6. Reverse proxy and certificate

Use one of the examples in [`deploy/`](../deploy):

- **nginx:** [`deploy/nginx.conf`](../deploy/nginx.conf)
- **Apache:** [`deploy/apache-vhost.conf`](../deploy/apache-vhost.conf)
  (with `certbot --apache` for the certificate)

Check from outside:

```bash
curl -s https://mcp.example.com/.well-known/oauth-protected-resource/mcp
```

Port 3900 must not be reachable from outside; by default it listens on
`127.0.0.1` only.

### Updating

```bash
cd /opt/dolibarr-mcp-server && git pull --ff-only && npm ci && npm run build && npm prune --omit=dev && chgrp -R dolibarr-mcp . && chmod -R g+rX,o-rwx . && systemctl restart dolibarr-mcp
```

Sign-ins survive an update. Clients read the new tool list at their next
session.

## Option B: Docker

```bash
docker build -t dolibarr-mcp-server .
docker run -d --name dolibarr-mcp \
  -p 127.0.0.1:3900:3900 \
  -v dolibarr-mcp-data:/data \
  -e DOLIBARR_URL=https://erp.example.com \
  -e DOLIBARR_NAME="Example Company ERP" \
  -e MCP_PUBLIC_URL=https://mcp.example.com \
  -e MCP_SECRET_KEY=<output of: openssl rand -hex 32> \
  -e MCP_TRUST_PROXY=uniquelocal \
  dolibarr-mcp-server
```

The image runs HTTP mode as an unprivileged user and keeps its database in the
`/data` volume. Put the same reverse proxy in front of it as above. Set
`MCP_TRUST_PROXY` to match how the proxy reaches the container (for example
`uniquelocal` for a proxy on a Docker network), so that sign-in rate limiting
sees the real client address.

Admin commands run inside the container:

```bash
docker exec -it dolibarr-mcp node dist/index.js token list
```

## Connecting clients

- **Claude (desktop, web and mobile apps):** Settings → Connectors → Add custom
  connector, with the URL `https://mcp.example.com/mcp`. Claude opens the
  sign-in page; sign in with your Dolibarr login and password.
- **Other MCP clients** that support remote servers with OAuth: use the same
  URL. The server supports dynamic client registration, PKCE and the OAuth
  protected resource metadata of the MCP specification.
- **Automated agents** without a person to sign in: create a token with the
  admin command (see [administration.md](administration.md)) and send it as
  `Authorization: Bearer <token>`.

## Backup

Back up the database file (`MCP_DB_PATH`) and the settings file. Losing them
only means that everyone signs in again and the audit log is lost; no
Dolibarr data is stored by the server.
