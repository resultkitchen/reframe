/**
 * Register-keyed user-facing strings.
 *
 * Two registers — `vibe` (founder / non-technical) and `technical` (engineer
 * who'll execute the fix). The Vibe/Technical toggle in the top bar swaps
 * `currentRegister` and every label in the SPA flows through `t(key)`.
 *
 * Rules (from the brief + voice guide):
 *  - Fragments are weapons.
 *  - Specific numbers.
 *  - Capitalize for emphasis. Never italicize.
 *  - No emoji. No "leverage". No "synergy".
 *  - Vibe never says "manifest", "fan-out", "telemetry", "approval bundle".
 */
import type { Register } from './types';

type CopyMap = Record<string, { vibe: string; technical: string }>;

const COPY: CopyMap = {
  // Top bar
  'topbar.tagline':          { vibe: 'Find what\'s broken. Ship the fix.',     technical: 'Visual Refactoring Workspace' },
  'topbar.serverOnline':     { vibe: 'Connected',                              technical: 'LOCAL SERVER ONLINE' },
  'topbar.serverOffline':    { vibe: 'Showing mock data',                      technical: 'SIMULATED RUN' },
  'topbar.primary':          { vibe: 'Send approved fixes to my IDE',          technical: 'Export approval bundle' },
  'topbar.primaryHint':      { vibe: 'Copies a prompt and a resume command — paste both into Claude Code or your terminal.', technical: 'Writes approvals.json and emits the resume command for npx reframe rebuild.' },
  'topbar.toggleVibe':       { vibe: 'Vibe',                                   technical: 'Vibe' },
  'topbar.toggleTechnical':  { vibe: 'Technical',                              technical: 'Technical' },
  'topbar.toggleAria':       { vibe: 'Switch between vibe-coder and technical views', technical: 'Switch between vibe-coder and technical views' },
  'topbar.runInfo':          { vibe: 'Run info',                               technical: 'Run metadata' },
  'topbar.runDirLabel':      { vibe: 'Where the run is saved',                 technical: 'Run directory' },
  'topbar.nonGitWorkspace':  { vibe: 'No git here — fixes won\'t auto-commit', technical: 'Non-git workspace' },
  'topbar.autosaved':        { vibe: 'Saved',                                  technical: 'Auto-saved' },

  // Sidebar
  'sidebar.heading':         { vibe: 'Screens',                                technical: 'Screens' },
  'sidebar.overview':        { vibe: 'All screens',                            technical: 'Run overview' },
  'sidebar.engineDrawer':    { vibe: 'Run internals',                          technical: 'Engine state' },
  'sidebar.collapse':        { vibe: 'Hide',                                   technical: 'Collapse' },
  'sidebar.expand':          { vibe: 'Show',                                   technical: 'Expand' },

  // Findings panel
  'findings.heading':        { vibe: 'What to fix first',                      technical: 'Findings — ranked' },
  'findings.empty':          { vibe: 'Nothing to fix on this screen. Clean.',  technical: 'No findings recorded for this route.' },
  'findings.filter.all':     { vibe: 'All',                                    technical: 'All' },
  'findings.filter.func':    { vibe: 'Bugs',                                   technical: 'Functional' },
  'findings.filter.a11y':    { vibe: 'Accessibility',                          technical: 'A11y' },
  'findings.filter.brand':   { vibe: 'Brand',                                  technical: 'Brand' },
  'findings.filter.compli':  { vibe: 'Compliance',                             technical: 'Compliance' },
  'findings.approve':        { vibe: 'Will fix',                               technical: 'Approve' },
  'findings.skip':           { vibe: 'Skip',                                   technical: 'Skip' },
  'findings.undo':           { vibe: 'Undo',                                   technical: 'Undo' },
  'findings.comment':        { vibe: 'Comment',                                technical: 'Comment' },
  'findings.copyPrompt':     { vibe: 'Copy as prompt',                         technical: 'Copy prompt block' },
  'findings.copyPromptDone': { vibe: 'Copied — paste into Claude Code',        technical: 'Prompt copied to clipboard' },
  'findings.willFix':        { vibe: 'Will fix',                               technical: '✓ Will rewrite' },
  'findings.skipped':        { vibe: 'Skipped',                                technical: '⚪ Skipped' },
  'findings.whyHeader':      { vibe: 'Why this matters',                       technical: 'Why it matters' },
  'findings.fixHeader':      { vibe: 'Suggested fix',                          technical: 'Required fix' },
  'findings.copyTerminal':   { vibe: 'Copy terminal command',                  technical: 'Copy reframe --resume command' },
  'findings.commentPlaceholder': { vibe: 'Add a note for the agent…',          technical: 'Comment for the engineer applying the fix…' },

  // Preview pane
  'preview.heading':         { vibe: 'What it looks like',                     technical: 'Preview' },
  'preview.phone':           { vibe: 'Phone',                                  technical: 'Mobile' },
  'preview.tablet':          { vibe: 'Tablet',                                 technical: 'Tablet' },
  'preview.desktop':         { vibe: 'Desktop',                                technical: 'Desktop' },
  'preview.openTab':         { vibe: 'Open the page',                          technical: 'Open in new tab' },
  'preview.noShot':          { vibe: 'No preview captured for this screen.',   technical: 'No screenshot available — run completed without an image capture for this route.' },

  // Brand panel
  'brand.heading':           { vibe: 'Brand',                                  technical: 'Brand tokens' },
  'brand.colors':            { vibe: 'Colors',                                 technical: 'Color tokens' },
  'brand.type':              { vibe: 'Type',                                   technical: 'Type ladder' },
  'brand.voice':             { vibe: 'Voice',                                  technical: 'Voice descriptors' },
  'brand.bibleOpen':         { vibe: 'Show the extracted brand bible',         technical: 'Show full brand bible (JSON)' },
  'brand.copyHex':           { vibe: 'Click a colour to copy',                 technical: 'Click swatch to copy hex' },
  'brand.copied':            { vibe: 'Copied',                                 technical: 'Copied to clipboard' },
  'brand.editRerun':         { vibe: 'Edit brand and re-audit this screen',    technical: 'Edit brand bible & re-run verify' },
  'brand.editRerunStub':     { vibe: 'Coming soon. For now: edit brand.resolved.json in the run directory and re-run npx reframe verify <runDir> from your terminal.', technical: 'Coming soon — runs npx reframe verify <runDir> from your terminal in the meantime.' },

  // Contract panel
  'contract.heading':        { vibe: 'Data',                                   technical: 'Data contracts' },
  'contract.callsHeading':   { vibe: 'What it talks to',                       technical: 'Data calls' },
  'contract.brokenHeading':  { vibe: 'Broken connections',                     technical: 'Broken contracts' },
  'contract.noBroken':       { vibe: 'No broken connections found.',           technical: 'No broken contracts detected on this run.' },
  'contract.noCalls':        { vibe: 'No data calls detected on this screen.', technical: 'No data calls recorded for this route.' },

  // Product summary
  'summary.heading':         { vibe: 'About this app',                         technical: 'Product summary' },
  'summary.findingsCount':   { vibe: 'to look at',                             technical: 'findings' },
  'summary.screensCount':    { vibe: 'screens audited',                        technical: 'screens audited' },

  // Misc
  'common.copy':             { vibe: 'Copy',                                   technical: 'Copy' },
  'common.close':            { vibe: 'Close',                                  technical: 'Close' },
  'common.cancel':           { vibe: 'Cancel',                                 technical: 'Cancel' },
  'common.send':             { vibe: 'Send',                                   technical: 'Send' },
  'common.retry':            { vibe: 'Try again',                              technical: 'Retry connection' },
};

export function t(key: string, register: Register): string {
  const entry = COPY[key];
  if (!entry) return key;
  return entry[register];
}
