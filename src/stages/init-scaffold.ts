/**
 * Stage Init — Scaffolder.
 *
 * Scaffolds the standard config/ directory templates inside a target codebase
 * so developers can immediately customize brand tokens, auth details, and
 * legal rules for Reframe scans.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** Source templates directory. config.ts is in src/, so root is one level up. */
const REPO_ROOT = path.resolve(__dirname, '..', '..');

/**
 * Execute project initialization scaffolding.
 */
export async function runInitScaffold(targetPath?: string): Promise<void> {
  const target = targetPath ? path.resolve(targetPath) : process.cwd();

  console.log(`[reframe] initializing config templates inside "${target}"`);

  // Target directories.
  const configDir = path.join(target, 'config');
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }

  const templates = [
    { src: 'brand.template.json', dest: 'brand.template.json' },
    { src: 'auth.template.json', dest: 'auth.template.json' },
    { src: 'constraints.template.json', dest: 'constraints.template.json' },
  ];

  let copied = 0;
  for (const t of templates) {
    const srcPath = path.join(REPO_ROOT, 'config', t.src);
    const destPath = path.join(configDir, t.dest);

    if (!fs.existsSync(srcPath)) {
      console.warn(`[reframe] WARNING: Source template not found at "${srcPath}"`);
      continue;
    }

    if (fs.existsSync(destPath)) {
      console.log(`[reframe] file already exists (skipped): "config/${t.dest}"`);
      continue;
    }

    try {
      fs.copyFileSync(srcPath, destPath);
      console.log(`[reframe] created template: "config/${t.dest}"`);
      copied += 1;
    } catch (err) {
      console.error(
        `[reframe] ERROR: Could not write template to "${destPath}": ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  }

  console.log(`\n[reframe] initialization complete! ${copied} template(s) created.`);
  console.log(`\nNext steps for non-technical users:`);
  console.log(`1. Open "config/brand.template.json" and customize your colors, spacing, and design rule hexes.`);
  console.log(`2. Open "config/auth.template.json" and add login page selectors and test account details.`);
  console.log(`3. Open "config/constraints.template.json" and add legal rules (e.g. TCPA checkboxes).`);
  console.log(`4. Run: reframe rebuild ${targetPath || '.'} --apply-mode review --auth config/auth.template.json`);
}
