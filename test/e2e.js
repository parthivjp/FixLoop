// End-to-end test with a FAKE model server (no internet, no API key).
// It replays a scripted "model" through the REAL agent loop, tools and safety rules.
// Run: npm run e2e
import http from 'node:http'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { spawn } from 'node:child_process'; import assert from 'node:assert/strict'; import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = [
  [{ name: 'run_tests', args: {} }],
  [{ name: 'read_file', args: { path: 'src/cart.js' } }, { name: 'read_file', args: { path: 'src/utils.js' } }],
  [{ name: 'edit_file', args: { path: 'src/utils.js', old_text: 'price - price * pct', new_text: 'price - (price * pct) / 100' } },
   { name: 'edit_file', args: { path: 'src/cart.js', old_text: 'sum + i.price,', new_text: 'sum + i.price * i.qty,' } },
   { name: 'edit_file', args: { path: 'src/cart.js', old_text: 'return this.items.reduce((a, b) => (a.price > b.price ? a : b));', new_text: 'if (!this.items.length) return null;\n    return this.items.reduce((a, b) => (b.price > a.price ? b : a));' } },
   { name: 'edit_file', args: { path: 'test/cart.test.js', old_text: 'equal', new_text: 'ok' } }],
  [{ name: 'run_tests', args: {} }],
  [{ name: 'finish', args: { root_cause: 'pct not divided by 100; qty ignored; empty cart crash', summary: 'Fixed 3 bugs.' } }],
];

async function scenario(kind) {
  let n = 0;
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', (d) => (body += d)); req.on('end', () => {
      const send = (o) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(o)); };
      if (req.method === 'GET') return send(kind === 'gemini'
        ? { models: [{ name: 'models/gemini-fake-flash', supportedGenerationMethods: ['generateContent'] }] } : { data: [{ id: 'fake-model' }] });
      const step = SCRIPT[Math.min(n++, SCRIPT.length - 1)];
      if (kind === 'gemini') return send({ candidates: [{ content: { role: 'model', parts: step.map((c) => ({ functionCall: c })) } }], usageMetadata: { totalTokenCount: 5 } });
      send({ choices: [{ message: { role: 'assistant', content: null, tool_calls: step.map((c, i) => ({ id: `c${n}_${i}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) } }], usage: { total_tokens: 5 } });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fixloop-e2e-'));
  fs.cpSync(path.join(root, 'demo/buggy-app'), tmp, { recursive: true });
  const env = { ...process.env, GROQ_API_KEY: '', OPENROUTER_API_KEY: '', GEMINI_API_KEY: '', LLM_API_KEY: '', LLM_PROVIDER: kind === 'gemini' ? 'gemini' : 'custom' };
  if (kind === 'gemini') Object.assign(env, { GEMINI_API_KEY: 'fake', GEMINI_BASE_URL: base });
  else Object.assign(env, { LLM_API_KEY: 'fake', LLM_BASE_URL: base });
  const p = spawn(process.execPath, [path.join(root, 'src/agent.js'), tmp], { env, cwd: root });
  let out = ''; p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (out += d));
  const code = await new Promise((r) => p.on('close', r));
  server.close();
  assert.equal(code, 0, out);
  assert.match(out, /VERIFIED/, out);
  assert.match(out, /test files are read-only/, 'blocked edit should be reported');
  const report = fs.readFileSync(path.join(tmp, 'FIXLOOP_REPORT.md'), 'utf8');
  assert.match(report, /Verified fixed/); assert.match(report, /read-only/);
  console.log(`e2e OK (${kind} protocol): 3 bugs fixed, test-edit blocked, independently verified`);
}
await scenario('openai');
await scenario('gemini');
