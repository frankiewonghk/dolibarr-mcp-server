# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [1.0.1] - 2026-11-27

### Fixed

- Error messages now include the details Dolibarr returns with an error. For
  example, "Error creating thirdparty" now carries the reason, "Customer code
  required (ErrorCustomerCodeRequired)". Untranslated `Error*` language keys
  are spelled out.

## [1.0.0] - 2026-11-17

### Added

- MCP server for the standard Dolibarr REST API, with 92 tools in 11
  toolsets: core, thirdparties, products, sales, invoices, purchasing, stock,
  production, projects, tickets and agenda.
- Confirmation guard for irreversible steps (preview first, then
  `confirm: true` with a reason).
- stdio mode for local use with one API key.
- HTTP mode with OAuth 2.1 sign-in through Dolibarr's login, encrypted key
  storage, long-lived tokens for automated agents and an audit log.
- Workflow prompts for common tasks.
- Deployment examples for systemd, nginx, Apache and Docker.
