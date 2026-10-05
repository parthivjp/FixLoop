#!/usr/bin/env node
// FixLoop: a self-healing agent. Gemini function calling + a verify-don't-trust loop.
import fs from 'node:fs';
import path from 'node:path';
import { Workspace, toolDeclarations, execute } from './tools.js';
import { pickProvider } from './llm.js';

// ---- tiny .env loader (no dependencies) ----
try {
  for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch {}

const MAX_STEPS = Number(process.env.FIXLOOP_MAX_STEPS || 15);

const SYSTEM = `You are FixLoop, an autonomous debugging agent. Goal: make the project's failing tests pass by fixing SOURCE code.
Method:
1. Call run_tests first. Read the failures carefully.
2. Read the failing test AND the source it exercises. Form a hypothesis about the root cause.
3. Make the smallest correct edit with edit_file. Never change test files (they are read-only and define correct behaviour).
4. Call run_tests again. If still failing, re-read and refine. Several bugs may exist.
5. When all tests pass (or you are truly stuck), call finish with the root cause.
Be efficient: use parallel tool calls when steps are independent. Do not guess file contents; read them.`;

const c = { dim: (s) => `\x1b[2m${s}\x1b[0m`, g: (s) => `\x1b[32m${s}\x1b[0m`, r: (s) => `\x1b[31m${s}\x1b[0m`, b: (s) => `\x1b[36m${s}\x1b[0m` };

function summarize(name, args) {
  const a = { ...args };
  for (const k of ['old_text', 'new_text']) if (a[k]) a[k] = a[k].length > 40 ? a[k].slice(0, 40) + '…' : a[k];
  return `${name}(${Object.entries(a).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ')})`;
}

async function run(dir) {
  const ws = new Workspace(dir);
  console.log(c.b(`\nFixLoop → ${ws.root}\n`));
  const before = ws.run_tests();
  console.log(`Baseline: ${c.r(before.failed + ' failing')}, ${before.passed} passing\n`);
  if (!before.ok && before.passed + before.failed === 0) { console.log(c.r('Tests did not run properly. Output:\n') + before.output); return; }
  if (before.ok) { console.log(c.g('All tests already pass. Nothing to fix.')); return; }

  const llm = pickProvider(process.env, (m) => console.log(c.dim('  ' + m)));
  llm.start(SYSTEM, `Project folder is ready. Initial test result: ${before.passed} passed, ${before.failed} failed. Fix it.`);
  const log = [];
  let finished = null, tokens = 0, announced = false;

  for (let step = 1; step <= MAX_STEPS && !finished; step++) {
    let turn;
    try {
      turn = await llm.step(toolDeclarations);
    } catch (e) {
      console.log(c.r(`LLM error: ${e.message}`));
      break;
    }
    if (!announced) { console.log(c.dim(`  provider: ${llm.label}, model: ${turn.model}\n`)); announced = true; }
    tokens += turn.tokens;
    if (turn.text.trim()) console.log(c.dim(`[${step}] ${turn.text.trim().slice(0, 300)}`));
    if (!turn.calls.length) { llm.nudge('Continue using tools, or call finish.'); continue; }

    const results = [];
    for (const { id, name, args } of turn.calls) {
      let result;
      try {
        if (name === 'finish') { finished = args; result = { ok: true }; }
        else result = execute(ws, name, args);
        const tag = name === 'run_tests' ? (result.ok ? c.g('PASS') : c.r(`${result.failed} failing`)) : '';
        console.log(`[${step}] ${summarize(name, args)} ${tag}`);
      } catch (e) {
        result = { error: e.message };
        console.log(`[${step}] ${summarize(name, args)} ${c.r('✗ ' + e.message)}`);
      }
      log.push({ step, name, args, error: result.error });
      results.push({ id, name, result });
    }
    llm.addResults(results);
  }

  // Never trust the model's claim: verify independently.
  const after = ws.run_tests();
  const success = after.ok;
  console.log(`\n${success ? c.g('✔ VERIFIED: all tests pass') : c.r('✘ Tests still failing')} (${after.passed} passed, ${after.failed} failed)`);
  fs.writeFileSync(path.join(ws.root, 'FIXLOOP_REPORT.md'), report({ ws, before, after, finished, log, tokens, success }));
  console.log(`Report: ${path.join(ws.root, 'FIXLOOP_REPORT.md')}`);
  console.log(c.dim(`Undo everything with: node src/agent.js "${dir}" --rollback`));
}

function report({ ws, before, after, finished, log, tokens, success }) {
  const diffs = ws.diffs().map((d) => `### ${d.file}\n\`\`\`diff\n${d.diff}\n\`\`\``).join('\n\n') || '_No files changed._';
  const blocked = log.filter((l) => l.error).map((l) => `- step ${l.step}: \`${l.name}\` → ${l.error}`).join('\n') || '_None_';
  return `# FixLoop Report\n\n**Result:** ${success ? '✅ Verified fixed' : '❌ Not fixed'}\n\n| | Passed | Failed |\n|---|---|---|\n| Before | ${before.passed} | ${before.failed} |\n| After | ${after.passed} | ${after.failed} |\n\n## Root cause (agent's explanation)\n${finished?.root_cause || '_agent did not finish_'}\n\n${finished?.summary || ''}\n\n## Changes\n${diffs}\n\n## Tool calls blocked by safety rules\n${blocked}\n\nTool calls: ${log.length} · Tokens: ${tokens}\n`;
}

// ---- CLI ----
const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith('--'));
if (!dir || args.includes('--help')) {
  console.log('Usage:\n  node src/agent.js <project-folder>\n  node src/agent.js <project-folder> --rollback\n\nPut GROQ_API_KEY, OPENROUTER_API_KEY or GEMINI_API_KEY in .env'); process.exit(0);
}
if (args.includes('--rollback')) {
  const ws = new Workspace(dir); const files = ws.rollback();
  console.log(files.length ? `Restored: ${files.join(', ')}` : 'Nothing to roll back.');
} else {
  run(dir).catch((e) => { console.error(c.r('Error: ' + e.message)); process.exit(1); });
}
