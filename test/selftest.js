// Offline test: proves the safety rules without calling any AI. Run: npm run selftest
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Workspace } from '../src/tools.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fixloop-'));
fs.cpSync(fileURLToPath(new URL('../demo/buggy-app', import.meta.url)), tmp, { recursive: true });
const ws = new Workspace(tmp);
const throws = (fn, re) => assert.throws(fn, re);

assert.equal(ws.run_tests().ok, false);
throws(() => ws.read_file({ path: '../../etc/passwd' }), /outside/);
throws(() => ws.read_file({ path: 'node_modules/x' }), /protected/);
throws(() => ws.edit_file({ path: 'test/cart.test.js', old_text: 'equal', new_text: 'ok' }), /read-only/);
throws(() => ws.edit_file({ path: 'src/cart.js', old_text: 'nope-not-here', new_text: 'x' }), /exactly once/);
throws(() => ws.edit_file({ path: 'src/cart.js', old_text: 'this.items', new_text: 'x' }), /exactly once/);

ws.edit_file({ path: 'src/utils.js', old_text: 'price - price * pct', new_text: 'price - (price * pct) / 100' });
ws.edit_file({ path: 'src/cart.js', old_text: 'sum + i.price,', new_text: 'sum + i.price * i.qty,' });
ws.edit_file({ path: 'src/cart.js', old_text: 'return this.items.reduce((a, b) => (a.price > b.price ? a : b));',
  new_text: 'if (!this.items.length) return null;\n    return this.items.reduce((a, b) => (b.price > a.price ? b : a));' });
const r = ws.run_tests();
assert.equal(r.ok, true, r.output);
assert.equal(ws.diffs().length, 2);
console.log(ws.diffs().map((d) => `--- ${d.file}\n${d.diff}`).join('\n'));
ws.rollback();
assert.equal(ws.run_tests().ok, false);
console.log('\nselftest OK: sandbox, read-only tests, unique-match edits, verify, diff, rollback');
