# Reframe — project boundaries

## Scope & Boundaries: local-first open source

- **Repository scope:** this project (`reframe`) contains exclusively the **open-source local-first engine** and CLI (`reframe rebuild`, `reframe review <runDir>`, `reframe verify`, `reframe bootstrap`, `reframe init`).
- **No hosting / SaaS deployments.** No Netlify, Vercel, or Google Cloud active web deployments are configured in this repository.
- **Local-only flow.** Reframe runs on `localhost`, reads/writes local `approvals.json` files on disk, and produces resilient prompts you paste into your own IDE / co-pilot.
- **SaaS platform.** The commercial SaaS product (Firebase Hosting + Google Cloud Run) will live in a separate repository (`reframe-saas`), developed independently. Don't add hosting glue here.
