# FixLoop 🔁

**A self-healing AI agent.** Point it at a project with failing tests. It runs the tests, reads the code, finds the root cause, patches the source, re-runs the tests, and repeats until they pass. Then it writes a report with diffs.

Built with Node.js and LLM function calling (Groq, OpenRouter, Gemini, or any OpenAI-compatible API). **Zero npm dependencies.**

## Why it's different from a chatbot

The model is not trusted. All safety lives in code (`src/tools.js`), not in the prompt:

| Rule | How it's enforced |
|---|---|
| Can't touch files outside the project | Path sandbox rejects `..`, absolute paths, `node_modules`, `.git` |
| Can't cheat by editing tests | Test files are **read-only** in `edit_file` |
| Can't make sloppy edits | `old_text` must match **exactly once** or the edit is refused |
| Can't run arbitrary commands | `run_tests` runs one fixed command (`node --test`), no shell, 30s timeout |
| Can't lie about success | After the loop, FixLoop **re-runs the tests itself** and reports the real result |
| Every change is reversible | First edit of each file is backed up; `--rollback` restores everything |
| Can't loop forever | Hard step limit (default 15) |

It also uses parallel tool calls and automatic model fallback when a model is rate-limited.

## Tools the model can call
`list_files` · `read_file` · `search_code` · `run_tests` · `edit_file` · `finish`

## Quick start (Node 18+)

```bash
# 1. Add ONE key to a .env file (never commit it). Groq is free: console.groq.com/keys
echo GROQ_API_KEY=your_key_here > .env
#    or OPENROUTER_API_KEY=...  or GEMINI_API_KEY=...

# 2. Prove the safety rules offline (no API needed)
npm run selftest

# 3. Prove the whole agent loop against a fake model server (no API needed)
npm run e2e

# 4. Run the demo: a shopping cart with 3 planted bugs
npm run demo

# 5. Undo the agent's changes
npm run demo:reset
```

Use it on your own project (needs tests runnable with `node --test`):

```bash
node src/agent.js path/to/your/project
node src/agent.js path/to/your/project --rollback
```

## What you get
`FIXLOOP_REPORT.md` in the target project: before/after test counts, the agent's root-cause explanation, a diff of every change, and a list of tool calls that safety rules blocked.

## How the loop works
1. Baseline `run_tests`
2. Send results to Gemini with the tool declarations
3. Execute every `functionCall` it returns, feed back `functionResponse`s
4. Repeat until `finish` or the step limit
5. **Independent verification**, then report

## Config
| Env var | Meaning |
|---|---|
| `GROQ_API_KEY` / `OPENROUTER_API_KEY` / `GEMINI_API_KEY` | Pick one provider. Model is auto-discovered from the provider's model list |
| `LLM_PROVIDER` | Force `groq`, `openrouter`, `gemini` or `custom` |
| `LLM_MODEL` | Force a specific model name |
| `LLM_API_KEY` + `LLM_BASE_URL` | Any OpenAI-compatible server (`custom`) |
| `FIXLOOP_MAX_STEPS` | Step limit, default 15 |

## Limitations
Targets Node.js projects using the built-in test runner. It cannot fix bugs the tests don't cover, and it may fail on very large codebases.

## License
MIT
