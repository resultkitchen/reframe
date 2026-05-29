import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { spawn } from 'node:child_process';

/**
 * Start the zero-dependency Model Context Protocol (MCP) server.
 * Communicates via JSON-RPC over stdin/stdout.
 * Redirects all console.log/info output to stderr to prevent stdout stream corruption.
 */
export function startMcpServer(): Promise<void> {
  return new Promise<void>((resolve) => {
    // Gotcha 1 Tweak: Redirect all standard stdout logging to stderr
    const originalLog = console.log;
    const originalInfo = console.info;
    console.log = (...args) => console.error(...args);
    console.info = (...args) => console.error(...args);

    console.error('[reframe-mcp] Booting Reframe MCP Server...');
    console.error('[reframe-mcp] Stdout redirected to Stderr. Stdin listening for JSON-RPC packets.');

    process.stdin.setEncoding('utf8');
    process.stdin.resume();
    let inputBuffer = '';

    process.stdin.on('data', (chunk) => {
      inputBuffer += chunk;
      let boundary = inputBuffer.indexOf('\n');
      while (boundary !== -1) {
        const line = inputBuffer.slice(0, boundary).trim();
        inputBuffer = inputBuffer.slice(boundary + 1);
        if (line) {
          try {
            const request = JSON.parse(line);
            handleRequest(request);
          } catch (err) {
            sendError(null, -32700, `Parse error: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        boundary = inputBuffer.indexOf('\n');
      }
    });

    process.stdin.on('end', () => {
      console.error('[reframe-mcp] Connection closed. Exiting.');
      resolve();
    });
  });
}

function sendResponse(id: any, result: any): void {
  const payload = {
    jsonrpc: '2.0',
    id,
    result,
  };
  process.stdout.write(JSON.stringify(payload) + '\n');
}

function sendError(id: any, code: number, message: string): void {
  const payload = {
    jsonrpc: '2.0',
    id,
    error: {
      code,
      message,
    },
  };
  process.stdout.write(JSON.stringify(payload) + '\n');
}

async function handleRequest(req: any): Promise<void> {
  if (req.jsonrpc !== '2.0') {
    sendError(req.id || null, -32600, 'Invalid Request: missing jsonrpc "2.0"');
    return;
  }

  // Handle initialization notifications (which have no id)
  if (req.method === 'notifications/initialized') {
    console.error('[reframe-mcp] Client confirmed initialization.');
    return;
  }

  const { id, method, params } = req;

  try {
    switch (method) {
      case 'initialize': {
        sendResponse(id, {
          protocolVersion: '2024-11-05',
          capabilities: {
            tools: {},
          },
          serverInfo: {
            name: 'reframe-mcp',
            version: '0.3.0',
          },
        });
        break;
      }

      case 'tools/list': {
        sendResponse(id, {
          tools: [
            {
              name: 'reframe_list_runs',
              description: 'List all previous audit run directories in the "runs/" folder.',
              inputSchema: {
                type: 'object',
                properties: {},
              },
            },
            {
              name: 'reframe_get_run_summary',
              description: 'Read manifest, health, page list, and finding counts for a specific run directory.',
              inputSchema: {
                type: 'object',
                properties: {
                  runDir: {
                    type: 'string',
                    description: 'Path to the run directory (relative to current working directory or absolute).',
                  },
                },
                required: ['runDir'],
              },
            },
            {
              name: 'reframe_get_finding_context',
              description: 'Retrieve extensive markdown context (claim, fix, brand styles, API contracts, element locators) for a specific gap/finding in a run, optimized as a code-fixing instruction block for the AI agent.',
              inputSchema: {
                type: 'object',
                properties: {
                  runDir: {
                    type: 'string',
                    description: 'Path to the run directory.',
                  },
                  pageSlug: {
                    type: 'string',
                    description: 'Slug of the audited page/screen (e.g. "leads-table").',
                  },
                  findingId: {
                    type: 'string',
                    description: 'ID of the specific finding/gap (e.g. "gap-001" or "ruleId::location").',
                  },
                },
                required: ['runDir', 'pageSlug', 'findingId'],
              },
            },
            {
              name: 'reframe_verify_page',
              description: 'Execute a verification pass on a specific page of a run. Runs verification in read-only browser mode and reports back compiler states, assertion counts, logs, and passing outcome.',
              inputSchema: {
                type: 'object',
                properties: {
                  runDir: {
                    type: 'string',
                    description: 'Path to the run directory.',
                  },
                  pageSlug: {
                    type: 'string',
                    description: 'Slug of the audited page to verify.',
                  },
                },
                required: ['runDir', 'pageSlug'],
              },
            },
          ],
        });
        break;
      }

      case 'tools/call': {
        if (!params || !params.name) {
          sendError(id, -32602, 'Invalid params: missing tool name');
          return;
        }

        const toolName = params.name;
        const args = params.arguments ?? {};
        console.error(`[reframe-mcp] Calling tool: ${toolName} with args:`, args);

        const resultText = await executeTool(toolName, args);
        sendResponse(id, {
          content: [
            {
              type: 'text',
              text: resultText,
            },
          ],
          isError: false,
        });
        break;
      }

      default:
        sendError(id, -32601, `Method not found: ${method}`);
    }
  } catch (err) {
    sendError(id, -32603, `Internal error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function executeTool(name: string, args: any): Promise<string> {
  const cwd = process.cwd();

  switch (name) {
    case 'reframe_list_runs': {
      const runsPath = path.join(cwd, 'runs');
      if (!fs.existsSync(runsPath)) {
        return `## Reframe Runs\n\nNo runs directory found at \`${runsPath}\`.\nPlease execute a Reframe audit first using:\n\`npx reframe rebuild <target>\``;
      }

      const files = fs.readdirSync(runsPath);
      const dirs = files.filter((f) => {
        try {
          return fs.statSync(path.join(runsPath, f)).isDirectory();
        } catch {
          return false;
        }
      });

      if (dirs.length === 0) {
        return `## Reframe Runs\n\nThe \`runs/\` folder is empty. Please run an audit first.`;
      }

      let out = `## Reframe Runs\n\nFound ${dirs.length} run(s) in \`${runsPath}\`:\n\n`;
      for (const dir of dirs.sort().reverse()) {
        const dirPath = path.join(runsPath, dir);
        let details = '';
        try {
          const manifestPath = path.join(dirPath, 'manifest.json');
          if (fs.existsSync(manifestPath)) {
            const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
            details = ` — **Target:** \`${manifest.target}\`, **Pages:** ${manifest.pagesProcessed?.length || 0}`;
          }
        } catch {
          details = ' (incomplete/corrupt)';
        }
        out += `*   \`runs/${dir}\`${details}\n`;
      }
      return out;
    }

    case 'reframe_get_run_summary': {
      const runDir = path.resolve(cwd, args.runDir);
      if (!fs.existsSync(runDir)) {
        return `Error: Run directory \`${args.runDir}\` does not exist. Please check \`reframe_list_runs\`.`;
      }

      const manifestPath = path.join(runDir, 'manifest.json');
      if (!fs.existsSync(manifestPath)) {
        return `Error: \`manifest.json\` not found in \`${args.runDir}\`. Is this a valid Reframe run?`;
      }

      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        const approvalsPath = path.join(runDir, 'approvals.json');
        let approvalsCount = 0;
        let skipsCount = 0;

        if (fs.existsSync(approvalsPath)) {
          const approvals = JSON.parse(fs.readFileSync(approvalsPath, 'utf8'));
          approvalsCount = Object.values(approvals.gaps || {}).filter((v: any) => v.apply).length +
                           Object.values(approvals.complianceFindings || {}).filter((v: any) => v.apply).length;
          skipsCount = Object.values(approvals.gaps || {}).filter((v: any) => !v.apply).length +
                       Object.values(approvals.complianceFindings || {}).filter((v: any) => !v.apply).length;
        }

        let out = `# Run Summary: ${manifest.project || 'Project'}\n\n`;
        out += `*   **Target:** \`${manifest.target}\`\n`;
        out += `*   **Started At:** ${manifest.startedAt || 'N/A'}\n`;
        out += `*   **Boot Status:** \`${manifest.bootStatus || 'N/A'}\`\n`;
        out += `*   **Apply Mode:** \`${manifest.applyMode || 'N/A'}\`\n`;
        out += `*   **Approvals Ledger:** ${approvalsCount} approved, ${skipsCount} skipped\n\n`;

        out += `### Pages/Screens Audited:\n\n`;
        const pages = manifest.pagesProcessed || [];
        if (pages.length === 0) {
          out += `No pages processed yet.\n`;
        } else {
          out += `| Page Slug | URL | Status | Gaps Found | Gaps Closed | Compliance |\n`;
          out += `|-----------|-----|--------|------------|-------------|------------|\n`;
          for (const p of pages) {
            const status = p.pass ? '✅ PASS' : '❌ FAIL';
            out += `| \`${p.slug}\` | [Link](${p.url}) | ${status} | ${p.gapsFound} | ${p.gapsClosed} | ${p.complianceFindings || 0} |\n`;
          }
        }

        return out;
      } catch (err) {
        return `Error reading run summary: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    case 'reframe_get_finding_context': {
      const { runDir: rawRun, pageSlug, findingId } = args;
      const runDir = path.resolve(cwd, rawRun);

      if (!fs.existsSync(runDir)) {
        return `Error: Run directory \`${rawRun}\` not found.`;
      }

      const pageDir = path.join(runDir, 'pages', pageSlug);
      if (!fs.existsSync(pageDir)) {
        return `Error: Page directory for slug \`${pageSlug}\` not found at \`${pageDir}\`.`;
      }

      try {
        let finding: any = null;
        let isCompliance = false;

        // Try reading audit.json
        const auditPath = path.join(pageDir, 'audit.json');
        if (fs.existsSync(auditPath)) {
          const auditData = JSON.parse(fs.readFileSync(auditPath, 'utf8'));
          finding = (auditData.gaps || []).find((g: any) => g.id === findingId);
        }

        // Try reading compliance.json if not found in audit.json
        if (!finding) {
          const compliancePath = path.join(pageDir, 'compliance.json');
          if (fs.existsSync(compliancePath)) {
            const complianceData = JSON.parse(fs.readFileSync(compliancePath, 'utf8'));
            finding = (complianceData.findings || []).find((f: any) => f.id === findingId);
            if (finding) isCompliance = true;
          }
        }

        if (!finding) {
          return `Error: Finding \`${findingId}\` not found in page \`${pageSlug}\` under audit or compliance results.`;
        }

        // Gather additional context
        let brandInfo = 'No resolved brand spec available.';
        const brandPath = path.join(runDir, 'brand.resolved.json');
        if (fs.existsSync(brandPath)) {
          const brand = JSON.parse(fs.readFileSync(brandPath, 'utf8'));
          brandInfo = `*   **Brand Name:** ${brand.name || 'N/A'}\n`;
          brandInfo += `*   **Primary Accent Colors:** ${JSON.stringify(brand.colors || {})}\n`;
          brandInfo += `*   **Type Scale display/heading/body:** Display: ${brand.typeScale?.display || 'N/A'}, Heading: ${brand.typeScale?.heading || 'N/A'}, Body: ${brand.typeScale?.body || 'N/A'}\n`;
          brandInfo += `*   **Voice Descriptors:** \`${brand.voice || 'N/A'}\`\n`;
          brandInfo += `*   **Component Style Guide:** \`${brand.componentStyle || 'N/A'}\``;
        }

        let scopeInfo = 'No API or broken contract scopes logged.';
        const scopePath = path.join(runDir, 'scope.json');
        if (fs.existsSync(scopePath)) {
          const scope = JSON.parse(fs.readFileSync(scopePath, 'utf8'));
          const dataCalls = scope.dataCalls || [];
          const brokenContracts = scope.brokenContracts || [];
          scopeInfo = `*   **Page Data Calls:** ${dataCalls.length} registered API endpoint(s).\n`;
          if (brokenContracts.length > 0) {
            scopeInfo += `*   **Broken Contracts on Target:**\n`;
            for (const bc of brokenContracts) {
              scopeInfo += `    - \`${bc.location}\`: ${bc.description}\n`;
            }
          } else {
            scopeInfo += `*   **Broken Contracts:** None detected.`;
          }
        }

        let approvalsInfo = 'Unreviewed.';
        const approvalsPath = path.join(runDir, 'approvals.json');
        if (fs.existsSync(approvalsPath)) {
          const approvals = JSON.parse(fs.readFileSync(approvalsPath, 'utf8'));
          const map = isCompliance ? approvals.complianceFindings : approvals.gaps;
          const decision = map?.[findingId];
          if (decision) {
            approvalsInfo = decision.apply ? '✅ **APPROVED FOR FIXING**' : '❌ **SKIPPED**';
            if (decision.comment) approvalsInfo += `\n*   **Reviewer Comment:** *"${decision.comment}"*`;
          }
        }

        let out = `# Finding Context: ${findingId}\n\n`;
        out += `## Status & Reviewer Decision\n${approvalsInfo}\n\n`;

        out += `## Finding Details\n`;
        out += `*   **Claim/Summary:** ${finding.plain || finding.claim || finding.message || 'N/A'}\n`;
        out += `*   **Technical Details:** ${finding.whyItMatters || finding.description || 'N/A'}\n`;
        out += `*   **Severity:** \`${finding.severity || 'N/A'}\` | **Dimension:** \`${finding.dimension || 'N/A'}\` | **Confidence Tier:** \`${finding.tier || finding.confidenceTier || 'N/A'}\`\n`;
        out += `*   **Code Location:** \`${finding.filePath || 'N/A'}${finding.location ? `:${finding.location}` : ''}\`\n\n`;

        out += `## Suggested Fix\n\`\`\`\n${finding.suggestedFix || finding.fix || 'No automated fix suggested.'}\n\`\`\`\n\n`;

        out += `## Brand Style Boundaries (Inferred from Target)\n${brandInfo}\n\n`;

        out += `## Route Data Scopes\n${scopeInfo}\n\n`;

        out += `--- \n\n`;
        out += `### INSTRUCTION FOR THE AI AGENT:\n`;
        out += `Please implement a high-fidelity code fix for this issue. Make sure to:\n`;
        out += `1. Locate the file at \`${finding.filePath || ''}\`.\n`;
        out += `2. Edit the component to resolve the bug according to the **Suggested Fix** above.\n`;
        out += `3. Respect all **Brand Style Boundaries** (maintain color tokens, typography Display/Heading scales, and voice guidelines).\n`;
        out += `4. Once done, verify your changes using the \`reframe_verify_page\` tool with pageSlug: \`${pageSlug}\`.\n`;

        return out;
      } catch (err) {
        return `Error compiling finding context: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    case 'reframe_verify_page': {
      const { runDir: rawRun, pageSlug } = args;
      const runDir = path.resolve(cwd, rawRun);

      if (!fs.existsSync(runDir)) {
        return `Error: Run directory \`${rawRun}\` not found.`;
      }

      console.error(`[reframe-mcp] Spawning verification subprocess for page: ${pageSlug}`);

      return new Promise<string>((resolve) => {
        // Gotcha 2 Tweak: Safely spawn the subprocess without polluting the parent's stdout
        const child = spawn('node', [
          path.join(cwd, 'dist', 'cli.js'),
          'verify',
          runDir,
          '--page',
          pageSlug,
        ]);

        let stdoutBuffer = '';
        let stderrBuffer = '';

        child.stdout.on('data', (data) => {
          stdoutBuffer += data.toString();
        });

        child.stderr.on('data', (data) => {
          stderrBuffer += data.toString();
        });

        child.on('close', (code) => {
          console.error(`[reframe-mcp] Verification subprocess exited with code ${code}`);

          let out = `# Page Verification: ${pageSlug}\n\n`;
          if (code === 0) {
            out += `### Outcome: ✅ VERIFICATION PASSED\n\n`;
            out += `All Playwright browser checks and visual assertions for page \`${pageSlug}\` have passed successfully!\n\n`;
          } else {
            out += `### Outcome: ❌ VERIFICATION FAILED (Exit Code ${code})\n\n`;
            out += `The Playwright assertions or compiler checks failed. Please check the logs below to fix the code.\n\n`;
          }

          out += `#### Command Logs:\n\`\`\`text\n`;
          out += stdoutBuffer.trim() || stderrBuffer.trim() || '(No output logs generated)';
          out += `\n\`\`\`\n`;

          resolve(out);
        });

        child.on('error', (err) => {
          resolve(`Error running verification process: ${err.message}`);
        });
      });
    }

    default:
      throw new Error(`Tool not found: ${name}`);
  }
}
