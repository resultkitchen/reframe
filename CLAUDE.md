# Reframe — Project Boundaries & AI Guidelines

## Scope & Boundaries: Local-First Open Source

- **Repository Scope:** This project (`reframe`) contains exclusively the **open-source local-first engine** and CLI (`reframe rebuild`, `reframe review <runDir>`, `reframe verify`, `reframe bootstrap`, `reframe init`, and `reframe mcp`).
- **No SaaS Deployments:** No Netlify, Vercel, or Google Cloud active web deployments are configured in this repository. Keep the core engine lightweight and dependency-free.
- **Local-Only Flow:** Reframe runs on `localhost`, reads/writes local `approvals.json` files on disk, and acts as an MCP server.
- **SaaS Platform:** The commercial SaaS product (Firebase Hosting + Google Cloud Run) lives in a separate repository (`reframe-saas`).

---

## Build & Test Commands

Run these standard verification commands in order. All must pass before pushing (the Green-Quad):
```bash
npm run build           # Compiles TypeScript to dist/
npm test                # Executes unit tests
npm run check-fixtures  # Statically validates fixtures schema
npm run eval            # Runs self-consistency & live LLM evaluations
```

---

## CLI Subcommands

- `reframe init [path]` — Scaffolds a new project config template.
- `reframe bootstrap <target>` — Maps pages and derives brand candidates.
- `reframe pin <runDir>` — Programmatically locks candidate brands to `config/brand.json`.
- `reframe show-brand <runDir>` — Pretty-prints inferred brand specifications.
- `reframe rebuild <target>` — Executes full audit and refactoring pipeline.
- `reframe review <runDir>` — Boots the local visual React Review SPA.
- `reframe verify <runDir> [--page <slug>]` — Re-runs Agent 5 (Verify) against hand-fixed files (fast loop).
- `reframe mcp` — Spawns the Model Context Protocol (MCP) JSON-RPC stdin/stdout server.

---

## MCP Server Integration

To register this project as a native MCP tool source in your AI coding assistant (Claude Code, Claude Desktop, Cursor, etc.), configure it to spin up the local build:

```json
"mcpServers": {
  "reframe": {
    "command": "npx",
    "args": ["-y", "@resultkitchen/reframe", "mcp"]
  }
}
```

### Exposed Tools
*   `reframe_list_runs` — Lists past audit directories in `runs/`.
*   `reframe_get_run_summary` — Reads page metrics, gaps, and compliance counts.
*   `reframe_get_finding_context` — Prepares complete markdown prompt context for a specific finding (claim, fix, brand swatches, data contracts).
*   `reframe_verify_page` — Spawns background verify workers to validate hand-fixed files.
