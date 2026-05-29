# Reframe MCP Integration & Execution Skill

This documentation serves as an AI-optimised **Skill Instruction Set** for coding agents (Claude Code, Cursor, gemini-cli) on how to interact natively with **Reframe's Model Context Protocol (MCP) Server** to automate frontend refactoring, visual alignment, and accessibility/compliance audits.

---

## 1. Tool Dictionary

The Reframe MCP server exposes four primary tools. Use them in order to locate, understand, resolve, and verify visual and compliance gaps in a target codebase.

*   `reframe_list_runs()`
    *   **Description:** Lists previous audit run directories in the `runs/` folder.
    *   **When to use:** Use at the start of a session to identify where the active audit results are stored.
*   `reframe_get_run_summary(runDir)`
    *   **Description:** Reads the overall run manifest, health ratios, processed screens, and approved vs. skipped triages.
    *   **When to use:** Use to get a high-level list of screens and counts of visual gaps/compliance findings to target.
*   `reframe_get_finding_context(runDir, pageSlug, findingId)`
    *   **Description:** Retrieves full markdown context for a specific finding—including technical details, severity, suggested fixes, resolved brand style tokens, route data scopes, and broken contract locations.
    *   **When to use:** Use *before* writing any code. It provides the exact instructions and brand style boundaries required to implement a high-fidelity fix.
*   `reframe_verify_page(runDir, pageSlug)`
    *   **Description:** Executes a background Playwright browser verification pass against a single screen to validate changes.
    *   **When to use:** Use *after* modifying code. It reports back compiler states and passing/failing browser assertions to confirm the fix succeeded.

---

## 2. The 5-Step Triage & Refactoring Loop

Follow this loop strictly to achieve a high-fidelity, verified code fix without infinite looping or bloated context:

```
 ┌───────────────┐      ┌─────────────────────────┐      ┌───────────────────────────┐
 │   1. TRIAGE   │ ───► │  2. READ FINDING CONTEXT │ ───► │   3. IMPLEMENT CODE FIX   │
 └───────────────┘      └─────────────────────────┘      └─────────────┬─────────────┘
                                                                       │
 ┌───────────────┐      ┌─────────────────────────┐                    │
 │  5. COMPLETED │ ◄─── │    4. RUN VERIFICATION  │ ◄──────────────────┘
 └───────────────┘      └─────────────────────────┘
```

### Step 1: Triage
Call `reframe_list_runs()` and `reframe_get_run_summary(runDir)` to identify which page slugs are failing (`❌ FAIL`) and locate specific findings (e.g. `gap-001`).

### Step 2: Read Finding Context (Judicious Calling)
Call `reframe_get_finding_context(runDir, pageSlug, findingId)`. 
> [!IMPORTANT]
> **Judicious Calling Rule:** Do not request context for 10 findings simultaneously. Focus on **one finding at a time**. This keeps the context window lean, preserves rate limits, and prevents cognitive overload when writing code.

### Step 3: Implement Code Fix
Locate the target file path specified in the finding details. Write code to resolve the gap, strictly respecting:
1.  **The Inferred Brand Colors:** Keep color changes aligned with `Resolved Brand Style` tokens (never use generic primary colors).
2.  **Typography Display Scales:** Match displaying Display, Heading, or Body font scale custom properties.
3.  **Data Contracts:** Ensure any modified forms or interactive elements conform to the recorded API data contracts.

### Step 4: Run Verification
Call `reframe_verify_page(runDir, pageSlug)` to trigger the headless Playwright browser checks for that screen.
*   **If it passes (`✅ PASS`):** The finding is closed. Move to the next Triaged finding.
*   **If it fails (`❌ FAIL`):** Inspect the child logs returned by the tool, adjust your code modifications, and re-verify.

---

## 3. Safety & Performance Constraints

*   **Stdout Safety:** Inside the MCP workspace, never write custom logs to `process.stdout`—it corrupts the MCP JSON-RPC communication channel. All standard debug logging must go to `process.stderr` (e.g., `console.error`).
*   **Read-Only Verification:** Reframe verification passes run in read-only mode by default, skipping destructive clicks (payments, deletions, submits). Never bypass this configuration on a live production environment.
*   **Loop Cap:** Limit code-correction loops to a maximum of **3 attempts** per finding. If a verification fails 3 times consecutively, pause and ask the human operator for direction or context clarification.
