# Contributing

Thank you for helping improve the Dolibarr MCP server.

## Development setup

```bash
npm ci
cp .env.example .env    # point DOLIBARR_URL and DOLIBARR_API_KEY at a test instance
npm run dev -- stdio
```

Use a test Dolibarr instance, never production data, when trying write tools.

## Before opening a pull request

- `npm run typecheck` and `npm test` pass.
- New tools follow the conventions in the README ("Development"): named
  `dolibarr_<area>_<verb>`, registered with `readTool` or `writeTool`, guarded
  when the step cannot simply be undone, returning shaped data.
- Tools use only the standard Dolibarr REST API, so they work on any
  Dolibarr installation. Behaviour that depends on a third-party module belongs
  behind its own toolset.
- Tests cover new behaviour, including how Dolibarr's replies are shaped.
- User-facing text is plain and specific: say what happened and what to do.

## Reporting bugs

Open an issue with the Dolibarr version, the tool and arguments, the reply,
and what you expected. Remove any API keys, tokens and personal data first.
