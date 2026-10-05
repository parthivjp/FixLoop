// Tools the model may call. Every safety rule lives HERE, in code, not in the prompt.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const IGNORED = new Set(['node_modules', '.git', '.fixloop']);
const TEXT_EXT = /\.(c|m)?(js|ts|jsx|tsx|json|md|css|html)$/i;
const TEST_FILE = /(^|[\\/])(test|tests|__tests__)[\\/]|\.(test|spec)\.[cm]?[jt]sx?$/i;

export const toolDeclarations = [
  { name: 'list_files', description: 'List files in the project (or a sub-folder).',
    parameters: { type: 'OBJECT', properties: { dir: { type: 'STRING', description: 'Relative folder, default "."' } } } },
  { name: 'read_file', description: 'Read a file with line numbers. Optional line range.',
    parameters: { type: 'OBJECT', properties: { path: { type: 'STRING' }, start_line: { type: 'NUMBER' }, end_line: { type: 'NUMBER' } }, required: ['path'] } },
  { name: 'search_code', description: 'Case-insensitive text search across project source files.',
    parameters: { type: 'OBJECT', properties: { query: { type: 'STRING' } }, required: ['query'] } },
  { name: 'run_tests', description: 'Run the project test suite (node --test). Returns pass/fail counts and output.',
    parameters: { type: 'OBJECT', properties: {} } },
  { name: 'edit_file', description: 'Replace ONE exact occurrence of old_text with new_text. old_text must match exactly once. Test files are read-only.',
    parameters: { type: 'OBJECT', properties: { path: { type: 'STRING' }, old_text: { type: 'STRING' }, new_text: { type: 'STRING' } }, required: ['path', 'old_text', 'new_text'] } },
  { name: 'finish', description: 'Call when tests pass, or when you are stuck. Explain the root cause(s).',
    parameters: { type: 'OBJECT', properties: { root_cause: { type: 'STRING' }, summary: { type: 'STRING' } }, required: ['root_cause', 'summary'] } },
];

export class Workspace {
  constructor(root) {
    this.root = path.resolve(root);
    if (!fs.existsSync(this.root)) throw new Error(`Folder not found: ${this.root}`);
    this.backupDir = path.join(this.root, '.fixloop', 'backups');
  }

  // Sandbox: returns absolute path, throws if it escapes the project or touches ignored dirs.
  safe(p = '.') {
    const full = path.resolve(this.root, p);
    const rel = path.relative(this.root, full);
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Blocked: path is outside the project.');
    if (rel.split(path.sep).some((s) => IGNORED.has(s))) throw new Error('Blocked: protected folder.');
    return full;
  }
  rel(full) { return path.relative(this.root, full).split(path.sep).join('/'); }

  walk(dir, depth = 0, out = []) {
    if (depth > 4 || out.length > 300) return out;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (IGNORED.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) this.walk(full, depth + 1, out);
      else out.push(full);
    }
    return out;
  }

  list_files({ dir = '.' } = {}) {
    return { files: this.walk(this.safe(dir)).map((f) => this.rel(f) + (TEST_FILE.test(f) ? '  [read-only test]' : '')) };
  }

  read_file({ path: p, start_line, end_line }) {
    const full = this.safe(p);
    if (!fs.existsSync(full) || fs.statSync(full).isDirectory()) throw new Error('File not found.');
    const lines = fs.readFileSync(full, 'utf8').split(/\r?\n/);
    const s = Math.max(1, start_line || 1);
    const e = Math.min(lines.length, end_line || s + 149);
    return { path: p, total_lines: lines.length, content: lines.slice(s - 1, e).map((l, i) => `${s + i}: ${l}`).join('\n') };
  }

  search_code({ query }) {
    const q = String(query).toLowerCase();
    const hits = [];
    for (const f of this.walk(this.root).filter((f) => TEXT_EXT.test(f))) {
      fs.readFileSync(f, 'utf8').split(/\r?\n/).forEach((l, i) => {
        if (hits.length < 30 && l.toLowerCase().includes(q)) hits.push(`${this.rel(f)}:${i + 1}: ${l.trim()}`);
      });
    }
    return { matches: hits };
  }

  run_tests() {
    // Fixed command, no shell, hard timeout: the model cannot run arbitrary commands.
    const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap'], { cwd: this.root, encoding: 'utf8', timeout: 30000 });
    const out = `${r.stdout || ''}\n${r.stderr || ''}`;
    const num = (k) => Number((out.match(new RegExp(`^(?:# |ℹ )${k} (\\d+)`, 'm')) || [])[1] || 0);
    const res = { passed: num('pass'), failed: num('fail'), ok: r.status === 0, timed_out: r.error?.code === 'ETIMEDOUT',
      output: out.length > 1500 ? '...' + out.slice(-1500) : out };
    return res;
  }

  edit_file({ path: p, old_text, new_text }) {
    const full = this.safe(p);
    const rel = this.rel(full);
    if (TEST_FILE.test(rel)) throw new Error('Blocked: test files are read-only. Fix the source code, not the tests.');
    if (!fs.existsSync(full)) throw new Error('File not found.');
    if (!old_text) throw new Error('old_text is empty.');
    const raw = fs.readFileSync(full, 'utf8');
    const eol = raw.includes('\r\n') ? '\r\n' : '\n';
    const text = raw.replace(/\r\n/g, '\n');
    const count = text.split(old_text.replace(/\r\n/g, '\n')).length - 1;
    if (count !== 1) throw new Error(`old_text must match exactly once; found ${count} matches. Add more context.`);
    const backup = path.join(this.backupDir, rel);
    if (!fs.existsSync(backup)) { fs.mkdirSync(path.dirname(backup), { recursive: true }); fs.writeFileSync(backup, raw); }
    fs.writeFileSync(full, text.replace(old_text.replace(/\r\n/g, '\n'), () => new_text.replace(/\r\n/g, '\n')).replace(/\n/g, eol));
    return { edited: rel, note: 'Backup saved. Run run_tests to verify.' };
  }

  backups() {
    if (!fs.existsSync(this.backupDir)) return [];
    const out = [];
    const rec = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => (e.isDirectory() ? rec(path.join(d, e.name)) : out.push(path.join(d, e.name))));
    rec(this.backupDir);
    return out.map((b) => path.relative(this.backupDir, b));
  }

  rollback() {
    const files = this.backups();
    for (const rel of files) fs.copyFileSync(path.join(this.backupDir, rel), path.join(this.root, rel));
    fs.rmSync(path.join(this.root, '.fixloop'), { recursive: true, force: true });
    return files;
  }

  diffs() {
    return this.backups().map((rel) => ({
      file: rel.split(path.sep).join('/'),
      diff: lineDiff(fs.readFileSync(path.join(this.backupDir, rel), 'utf8'), fs.readFileSync(path.join(this.root, rel), 'utf8')),
    }));
  }
}

// Small LCS line diff (no dependencies).
export function lineDiff(a, b) {
  const A = a.split(/\r?\n/), B = b.split(/\r?\n/);
  const dp = Array.from({ length: A.length + 1 }, () => new Array(B.length + 1).fill(0));
  for (let i = A.length - 1; i >= 0; i--)
    for (let j = B.length - 1; j >= 0; j--)
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (i < A.length || j < B.length) {
    if (i < A.length && j < B.length && A[i] === B[j]) { i++; j++; }
    else if (i < A.length && (j === B.length || dp[i + 1][j] >= dp[i][j + 1])) out.push(`- ${A[i++]}`);
    else out.push(`+ ${B[j++]}`);
  }
  return out.join('\n');
}

export function execute(ws, name, args) {
  if (typeof ws[name] !== 'function' || name === 'safe') throw new Error(`Unknown tool: ${name}`);
  return ws[name](args || {});
}
