# OpenWolf

@.wolf/OPENWOLF.md

This project uses OpenWolf for context management. Read and follow .wolf/OPENWOLF.md every session. Check .wolf/cerebrum.md before generating code. Check .wolf/anatomy.md before reading files.

---

## 🏛️ Scope & Boundaries: Local-First Open Source
- **Repository Scope**: This project (`rebuild-pipeline`) contains exclusively the **Open-Source Local-First Engine** and CLI (`rebuild review <runDir>`).
- **No Hosting / SaaS Deployments**: There are **no** Netlify, Vercel, or Google Cloud active web deployments configured in this repository.
- **Local-Only Flow**: It runs on `localhost`, reads/writes local `approvals.json` files on your disk, and copy-pastes resilient prompts to your local IDE co-pilots.
- **SaaS Platform**: The commercial SaaS product (Firebase Hosting + Google Cloud Run) will reside in a separate repository (`rebuild-saas`), developed independently.
