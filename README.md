# Dolibarr MCP Server

[![CI](https://github.com/frankiewonghk/dolibarr-mcp-server/actions/workflows/ci.yml/badge.svg)](https://github.com/frankiewonghk/dolibarr-mcp-server/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server for
[Dolibarr ERP & CRM](https://www.dolibarr.org). It lets AI assistants such as
Claude look up and work with the data in a Dolibarr instance — third parties,
products, proposals, orders, shipments, invoices, purchasing, stock,
manufacturing, projects, tickets and the agenda — through Dolibarr's standard
REST API.

The server works with an unmodified Dolibarr installation. It keeps no
business data of its own: every call is made with the connected user's own
Dolibarr API key, so Dolibarr's permissions apply exactly as they do in the
web interface.

## Features

- **92 tools across 11 toolsets**, covering the standard Dolibarr modules.
  Enable only the toolsets you need.
- **Safe by design.** Creating and editing drafts happens directly. Steps that
  cannot simply be undone — validating, approving, closing, deleting, stock
  movements, payments — are *guarded*: they return a preview first and only
  run when called again with explicit confirmation and a reason.
- **Read-only mode**, per instance or per connection.
- **Two ways to run:**
  - **stdio** — a local process for one user, for Claude Desktop, Claude Code
    and other MCP clients.
  - **HTTP** — a remote server for a team, with OAuth 2.1 sign-in. Each person
    signs in with their own Dolibarr login; long-lived tokens are available
    for automated agents. Every tool call is written to an audit log.
- **Agent-friendly replies.** Responses are compacted (empty and internal
  fields removed, timestamps turned into dates, status codes into labels) and
  Dolibarr errors are explained in plain words with a hint on what to do next.
- **Generic fallback.** For anything not covered by a dedicated tool, the
  agent can search the instance's own API catalogue and call any endpoint.
- **Workflow prompts** for common tasks, such as preparing a quote, shipping
  and invoicing an order, or listing unpaid invoices.

## Requirements

- **Dolibarr** with the **API REST** module enabled. The server is developed
  and tested against Dolibarr 22.0; earlier versions with the REST API are
  likely to work for most tools but are not tested.
- **Node.js** 22.13 or later.
- A **Dolibarr API key** for each user (on the user card, *API key* field).
  In HTTP mode, a user who may edit their own user record gets a key
  automatically at first sign-in.

## Quick start (local, stdio)

```bash
git clone https://github.com/frankiewonghk/dolibarr-mcp-server.git
cd dolibarr-mcp-server
npm ci
npm run build
```

Then add the server to your MCP client.

**Claude Desktop** — edit `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "dolibarr": {
      "command": "node",
      "args": [
        "--disable-warning=ExperimentalWarning",
        "/absolute/path/to/dolibarr-mcp-server/dist/index.js",
        "stdio"
      ],
      "env": {
        "DOLIBARR_URL": "https://erp.example.com",
        "DOLIBARR_API_KEY": "your-dolibarr-api-key"
      }
    }
  }
}
```

**Claude Code:**

```bash
claude mcp add dolibarr --env DOLIBARR_URL=https://erp.example.com --env DOLIBARR_API_KEY=your-dolibarr-api-key -- node /absolute/path/to/dolibarr-mcp-server/dist/index.js stdio
```

Restart the client and ask, for example, *"Which customer invoices are
overdue?"* The agent starts with `dolibarr_whoami` to confirm the connection.

`DOLIBARR_URL` is the address of the Dolibarr site, without `/api/index.php`.

## Remote server (HTTP with OAuth)

In HTTP mode the server is shared by a team. Users connect from their MCP
client (for example *Claude → Settings → Connectors → Add custom connector*,
URL `https://mcp.example.com/mcp`), sign in on the server's sign-in page with
their Dolibarr login and password, and choose whether to allow changes or
look-ups only.

- The password is checked by Dolibarr (`POST /api/index.php/login`) and is
  never stored. The user's Dolibarr API key stays on the server, encrypted
  with AES-256-GCM.
- Clients receive short-lived access tokens (default 1 hour), renewed
  automatically with rotating refresh tokens (default 30 days).
- Tokens are stored only as SHA-256 hashes; a copy of the database file alone
  gives no access.
- Repeated failed sign-ins are rate-limited per login and per address.

Minimal configuration:

```bash
DOLIBARR_URL=https://erp.example.com
MCP_PUBLIC_URL=https://mcp.example.com
MCP_SECRET_KEY=$(openssl rand -hex 32)
```

```bash
npm start -- http
```

The server listens on `127.0.0.1:3900` and must be published over HTTPS
through a reverse proxy. See [docs/deployment.md](docs/deployment.md) for a
complete production setup (systemd, nginx or Apache, Docker) and
[docs/administration.md](docs/administration.md) for managing tokens and the
audit log.

## Configuration

All settings are environment variables. In local use they can also be placed
in a `.env` file (see [.env.example](.env.example)).

| Variable | Default | Description |
|---|---|---|
| `DOLIBARR_URL` | — | **Required.** Dolibarr site URL, without `/api/index.php`. |
| `DOLIBARR_API_KEY` | — | stdio mode: API key of the user the server acts as. |
| `DOLIBARR_NAME` | `Dolibarr` | Display name of the instance, shown to the agent and on the sign-in page. |
| `DOLIBARR_TOOLSETS` | `all` | `all`, or a comma-separated list of toolsets (see below). `core` is always on. |
| `DOLIBARR_WRITE_MODE` | `guarded` | `guarded`: write tools available, irreversible steps need confirmation. `off`: read-only for everyone. |
| `DOLIBARR_TIMEOUT_MS` | `30000` | Timeout of each Dolibarr API call. |
| `MCP_HOST` | `127.0.0.1` | HTTP mode: listen address. |
| `MCP_PORT` | `3900` | HTTP mode: listen port. |
| `MCP_PUBLIC_URL` | — | HTTP mode, **required**: public HTTPS address of this server, e.g. `https://mcp.example.com`. |
| `MCP_SECRET_KEY` | — | HTTP mode, **required**: 64 hex characters (`openssl rand -hex 32`). Encrypts stored API keys; changing it invalidates every sign-in and token. |
| `MCP_DB_PATH` | `./data/dolibarr-mcp.sqlite` | HTTP mode: SQLite file for clients, tokens and the audit log. |
| `MCP_ALLOWED_HOSTS` | `localhost,127.0.0.1` | HTTP mode: accepted `Host` headers, in addition to the public host name. |
| `MCP_TRUST_PROXY` | `loopback` | HTTP mode: which proxies may set `X-Forwarded-For` ([Express syntax](https://expressjs.com/en/guide/behind-proxies.html)). |
| `MCP_ACCESS_TTL_MIN` | `60` | Lifetime of access tokens, in minutes. |
| `MCP_REFRESH_TTL_DAYS` | `30` | Lifetime of refresh tokens, in days. |
| `MCP_AUDIT_KEEP_DAYS` | `365` | Days of audit log to keep. |

## Toolsets and tools

Search tools take free text and filters and return ids and refs; get tools
take an id or a ref. **Bold** tools are guarded (preview first, then
`confirm: true` with a `reason`). Write tools are not offered at all on a
read-only connection.

| Toolset | Dolibarr modules | Tools |
|---|---|---|
| `core` | API | `dolibarr_whoami`, `dolibarr_custom_field_list`, `dolibarr_dictionary`, `dolibarr_api_find_endpoint`, `dolibarr_api_get`, **`dolibarr_api_write`** |
| `thirdparties` | Third parties | `dolibarr_thirdparty_search`, `_get`, `_create`, `_update`; `dolibarr_contact_search`, `_get`, `_create`, `_update` |
| `products` | Products, Services | `dolibarr_product_search`, `_get`, `_create`, `_update` |
| `sales` | Commercial proposals, Sales orders, Shipments | `dolibarr_proposal_search`, `_get`, `_create`, `_update`, `_line`, **`_action`**; `dolibarr_order_search`, `_get`, `_create`, `_create_from_proposal`, `_update`, `_line`, **`_action`**; `dolibarr_shipment_search`, `_get`, `_create`, **`_action`** |
| `invoices` | Customer invoices | `dolibarr_invoice_search`, `_get`, `_create`, `_create_from_order`, `_update`, `_line`, **`_action`**, **`_record_payment`** |
| `purchasing` | Supplier orders, Receptions, Supplier invoices | `dolibarr_supplier_order_search`, `_get`, `_create`, `_update`, **`_action`**, **`_receive`**; `dolibarr_reception_search`, `_get`, `_create`, **`_action`**; `dolibarr_supplier_invoice_search`, `_get`, `_create`, `_line`, **`_action`**, **`_record_payment`** |
| `stock` | Stock | `dolibarr_warehouse_list`, `dolibarr_product_stock`, `dolibarr_stock_movement_search`, **`dolibarr_stock_correct`**, **`dolibarr_stock_transfer`** |
| `production` | BOM, Manufacturing orders | `dolibarr_bom_search`, `_get`, `_create`, `_line`, **`_delete`**; `dolibarr_mo_search`, `_get`, `_create`, **`_delete`**, **`_produce`** |
| `projects` | Projects | `dolibarr_project_search`, `_get`, `_create`, `_update`, **`_action`**; `dolibarr_task_get`, `_create`, `_update`, `_add_time` |
| `tickets` | Tickets | `dolibarr_ticket_search`, `_get`, `_create`, `_update`, `_add_message` |
| `agenda` | Agenda | `dolibarr_event_search`, `_get`, `_create`, `_update` |

The `*_action` tools move a document through its life cycle, for example:

| Tool | Actions |
|---|---|
| `dolibarr_proposal_action` | `validate`, `set_draft`, `sign`, `refuse`, `set_billed`, `delete` |
| `dolibarr_order_action` | `validate`, `set_draft`, `close`, `reopen`, `set_billed`, `delete` |
| `dolibarr_shipment_action` | `validate`, `close`, `delete` |
| `dolibarr_invoice_action` | `validate`, `set_draft`, `set_paid`, `set_unpaid`, `delete` |
| `dolibarr_supplier_order_action` | `validate`, `approve`, `mark_ordered`, `delete` |
| `dolibarr_reception_action` | `validate`, `close`, `delete` |
| `dolibarr_supplier_invoice_action` | `validate`, `set_draft`, `delete` |
| `dolibarr_project_action` | `validate`, `delete` |

### Workflow prompts

The server also offers prompts that guide the agent through common tasks. A
read-only connection receives only the read prompts.

| Prompt | Purpose |
|---|---|
| `customer_overview` | Open proposals, orders, unpaid invoices and recent activity of a customer |
| `order_status` | Where a sales order stands: lines, shipments, invoicing |
| `stock_check` | Stock of a product per warehouse and lot, with recent movements |
| `unpaid_invoices` | Unpaid customer invoices, oldest first, with what is overdue |
| `new_quote` | Prepare and validate a commercial proposal |
| `new_sales_order` | Enter and validate a sales order |
| `ship_and_invoice` | Ship a validated order and invoice it |
| `purchase_and_receive` | Order from a supplier, take the order through approval, receive the goods |
| `log_time` | Record time spent on a project task |

## How changes are kept safe

- Every call runs as the connected Dolibarr user. A refusal for missing
  rights (HTTP 403) is reported to the user and never worked around.
- A read-only connection (read token, or `DOLIBARR_WRITE_MODE=off`) does not
  receive the write tools at all.
- Creating and editing **drafts** is not guarded: a draft moves no stock, has
  no accounting effect and can be deleted.
- **Guarded** tools carry the MCP `destructiveHint` annotation, so clients ask
  the user before running them. Called without `confirm: true`, they change
  nothing and return a preview of the record and the effect of the step. With
  `confirm: true` they also require a `reason`, which is kept in the audit log
  in HTTP mode.
- Line updates send the complete line back to Dolibarr, so fields that were
  not meant to change are not reset.
- Replies longer than 60,000 characters are cut, with a note asking the agent
  to narrow the request.

## Limitations of the standard API

Some operations are not available through Dolibarr's standard REST API and
therefore not through this server:

- Bills of materials and manufacturing orders cannot be **validated** through
  the API. Validate them in the web interface; production can then be posted
  with `dolibarr_mo_produce`.
- **Lot- and serial-tracked products** cannot be shipped
  (`dolibarr_shipment_create`) or consumed and produced
  (`dolibarr_mo_produce`) through the API. Receiving them with a lot number is
  supported.
- **Supplier order lines** cannot be edited after creation; delete the draft
  and create it again.
- **PDF documents** are not generated by these tools; use the web interface
  or `dolibarr_api_find_endpoint` with the `documents` routes.

Anything else the API offers can be reached with `dolibarr_api_get` and, as a
guarded last resort, `dolibarr_api_write`.

## Development

```bash
npm ci
npm run dev -- stdio    # run from source (reads .env)
npm test                # unit and integration tests
npm run typecheck
npm run build
```

Project layout:

```
src/index.ts            entry point: stdio, http, or an admin command
src/server.ts           builds the MCP server and registers the enabled toolsets
src/config.ts           environment parsing
src/instructions.ts     guidance sent to the agent on connection
src/prompts.ts          workflow prompts
src/http.ts             HTTP mode: OAuth endpoints, sign-in page, /mcp endpoint
src/cli.ts              admin commands (tokens, audit log)
src/auth/               OAuth provider, token store, encryption, rate limiting
src/dolibarr/           REST client, transport, sign-in, response shaping
src/tools/              one file per toolset, plus shared helpers
test/                   vitest suites
deploy/                 systemd unit, reverse proxy examples, admin wrapper
```

To add a tool, register it in the matching file under `src/tools/` with
`readTool` (look-ups) or `writeTool` (changes; pass `guarded: true` for steps
that cannot simply be undone and supply a preview), name it
`dolibarr_<area>_<verb>`, and return shaped data rather than raw API objects.

## Contributing

Issues and pull requests are welcome. Please run `npm run typecheck` and
`npm test` before submitting, and see [CONTRIBUTING.md](CONTRIBUTING.md).
To report a security issue, follow [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE). Dolibarr is a trademark of its respective owners; this
project is an independent integration and is not affiliated with or endorsed
by the Dolibarr project.
