// Builds the site and force-pushes public/ to the gh-pages branch of origin (GitHub Pages serves it).
// Uses only plain git: no GitHub Actions, no extra token permissions.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const git = (args, cwd = root) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'inherit'] }).toString().trim();

execFileSync('node', [path.join(root, 'scripts/vendor.mjs')], { stdio: 'inherit' });
const remote = git(['remote', 'get-url', 'origin']);
const email = git(['config', 'user.email']); const name = git(['config', 'user.name']);
const rev = git(['rev-parse', '--short', 'HEAD']);
if (git(['status', '--porcelain', '--', 'public', 'scripts', 'package.json'])) console.warn('Warning: uncommitted changes in public/ will be published.');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfhero-pages-'));
try {
  fs.cpSync(path.join(root, 'public'), tmp, { recursive: true });
  fs.writeFileSync(path.join(tmp, '.nojekyll'), ''); // serve files as-is
  git(['init', '-q', '-b', 'gh-pages'], tmp);
  git(['-c', `user.email=${email}`, '-c', `user.name=${name}`, 'add', '-A'], tmp);
  git(['-c', `user.email=${email}`, '-c', `user.name=${name}`, 'commit', '-q', '-m', `Deploy ${rev}`], tmp);
  execFileSync('git', ['push', '--force', remote, 'gh-pages'], { cwd: tmp, stdio: 'inherit' });
  console.log(`Published ${rev} to gh-pages.`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
