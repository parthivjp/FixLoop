// LLM providers behind one tiny interface: start(), step(tools), addResults(), nudge().
// Supports Gemini, Groq, OpenRouter, or any OpenAI-compatible server.
const lowerTypes = (x) => JSON.parse(JSON.stringify(x, (k, v) => (k === 'type' && typeof v === 'string' ? v.toLowerCase() : v)));
const RETRY = [404, 429, 500, 503];
const TRUNCATED = '...[truncated]';

function truncate(text, limit) {
  const value = String(text);
  return value.length > limit ? `${value.slice(0, limit)}${TRUNCATED}` : value;
}

function rateLimitSeconds(r) {
  if (r.retryAfter !== null) return Math.max(0, r.retryAfter);
  const match = r.text?.match(/try again in\s+(\d+(?:\.\d+)?)\s*(ms|s)\b/i);
  if (!match) return 10;
  const value = Number(match[1]);
  return match[2].toLowerCase() === 'ms' ? value / 1000 : value;
}

async function waitForRateLimit(r, log) {
  const seconds = Math.min(60, rateLimitSeconds(r) + 1);
  log(`rate limited, waiting ${Math.ceil(seconds)}s...`);
  await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

async function post(url, headers, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const retryAfterHeader = res.headers.get('retry-after');
  const retryAfter = retryAfterHeader === null ? null : Number(retryAfterHeader);
  return { ok: res.ok, status: res.status, text: res.ok ? null : await res.text(), json: res.ok ? await res.json() : null,
    retryAfter: Number.isFinite(retryAfter) ? retryAfter : null };
}

export class GeminiProvider {
  constructor(key, log) {
    this.key = key; this.log = log; this.idx = 0; this.contents = [];
    this.base = process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta';
    this.label = 'Gemini';
  }
  async discover() {
    if (process.env.LLM_MODEL || process.env.GEMINI_MODEL) return [process.env.LLM_MODEL || process.env.GEMINI_MODEL];
    try {
      const r = await fetch(`${this.base}/models?pageSize=200`, { headers: { 'x-goog-api-key': this.key } });
      if (!r.ok) throw new Error(String(r.status));
      const ver = (n) => parseFloat((n.match(/gemini-(\d+(?:\.\d+)?)/) || [, 0])[1]);
      const names = (await r.json()).models.filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
        .map((m) => m.name.replace('models/', '')).filter((n) => /flash/.test(n) && !/image|tts|live|audio|embed|robot|computer|exp|vision|8b/.test(n))
        .sort((a, b) => (a.includes('preview') - b.includes('preview')) || ver(b) - ver(a) || (a.includes('lite') - b.includes('lite')) || a.length - b.length);
      if (names.length) return names.slice(0, 4);
    } catch (e) { this.log(`could not list models (${e.message})`); }
    return ['gemini-flash-latest', 'gemini-flash-lite-latest'];
  }
  start(system, user) { this.system = system; this.contents = [{ role: 'user', parts: [{ text: user }] }]; }
  async step(tools) {
    this.models ||= await this.discover();
    let rateLimitWaits = 0;
    const functionResponses = this.contents.flatMap((content) => content.parts || []).filter((part) => part.functionResponse);
    for (const part of functionResponses.slice(0, -4)) {
      const response = part.functionResponse.response;
      const result = response.result;
      if (typeof result === 'string' && result.endsWith(TRUNCATED)) continue;
      const serialized = typeof result === 'string' ? result : JSON.stringify(result);
      if (serialized?.length > 200) response.result = truncate(serialized, 200);
    }
    const body = { systemInstruction: { parts: [{ text: this.system }] }, contents: this.contents, tools: [{ functionDeclarations: tools }] };
    for (;;) {
      const m = this.models[this.idx];
      const r = await post(`${this.base}/models/${m}:generateContent`, { 'x-goog-api-key': this.key }, body);
      if (r.ok) {
        const parts = r.json.candidates?.[0]?.content?.parts || [];
        if (parts.length) this.contents.push({ role: 'model', parts });
        return { model: m, tokens: r.json.usageMetadata?.totalTokenCount || 0, text: parts.filter((p) => p.text).map((p) => p.text).join(' '),
          calls: parts.filter((p) => p.functionCall).map((p, i) => ({ id: String(i), name: p.functionCall.name, args: p.functionCall.args || {} })) };
      }
      if (r.status === 429) {
        if (rateLimitWaits < 5) {
          rateLimitWaits++;
          await waitForRateLimit(r, this.log);
          continue;
        }
        if (this.idx < this.models.length - 1) {
          this.log(`model ${m} rate limited, switching to ${this.models[this.idx + 1]}`);
          this.idx++;
          continue;
        }
      }
      if (RETRY.includes(r.status) && this.idx < this.models.length - 1) { this.log(`model ${m} unavailable (${r.status}), switching to ${this.models[this.idx + 1]}`); this.idx++; continue; }
      throw new Error(`Gemini error ${r.status}: ${r.text.slice(0, 300)}`);
    }
  }
  addResults(rs) { this.contents.push({ role: 'user', parts: rs.map((x) => ({ functionResponse: { name: x.name, response: { result: x.result } } })) }); }
  nudge(t) { this.contents.push({ role: 'user', parts: [{ text: t }] }); }
}

export class OpenAIProvider {
  constructor({ label, base, key, headers = {}, preferred = [], log }) {
    Object.assign(this, { label, base, key, extra: headers, preferred, log }); this.idx = 0; this.messages = [];
  }
  get headers() { return { Authorization: `Bearer ${this.key}`, ...this.extra }; }
  async discover() {
    if (process.env.LLM_MODEL) return [process.env.LLM_MODEL];
    try {
      const r = await fetch(`${this.base}/models`, { headers: this.headers });
      if (!r.ok) throw new Error(String(r.status));
      const data = (await r.json()).data || [];
      const ids = data.map((m) => m.id);
      let pick = this.preferred.filter((p) => ids.includes(p));
      if (this.label === 'OpenRouter') {
        pick = data.filter((m) => m.id.endsWith(':free') && m.supported_parameters?.includes('tools') && !/vision|image|vl/i.test(m.id))
          .sort((a, b) => (b.context_length || 0) - (a.context_length || 0)).map((m) => m.id).slice(0, 4);
      } else if (!pick.length) pick = ids.filter((i) => !/whisper|tts|guard|embed|playai|distil|orpheus|safeguard|compound/i.test(i)).slice(0, 3);
      if (pick.length) return pick;
    } catch (e) { this.log(`could not list models (${e.message})`); }
    return this.preferred.length ? this.preferred : ['gpt-4o-mini'];
  }
  start(system, user) { this.messages = [{ role: 'system', content: system }, { role: 'user', content: user }]; }
  async step(tools) {
    this.models ||= await this.discover();
    const fns = lowerTypes(tools).map((t) => ({ type: 'function', function: t }));
    let rateLimitWaits = 0;
    for (;;) {
      const m = this.models[this.idx];
      const toolMessages = this.messages.filter((message) => message.role === 'tool');
      for (const message of toolMessages.slice(0, -4)) message.content = truncate(message.content, 200);
      const r = await post(`${this.base}/chat/completions`, this.headers, { model: m, messages: this.messages, tools: fns, tool_choice: 'auto', temperature: 0 });
      if (r.ok) {
        const msg = r.json.choices?.[0]?.message || {};
        this.messages.push({ role: 'assistant', content: msg.content ?? '', ...(msg.tool_calls?.length ? { tool_calls: msg.tool_calls } : {}) });
        return { model: m, tokens: r.json.usage?.total_tokens || 0, text: msg.content || '',
          calls: (msg.tool_calls || []).map((c) => { let args = {}; try { args = JSON.parse(c.function.arguments || '{}'); } catch {} return { id: c.id, name: c.function.name, args }; }) };
      }
      if (r.status === 429) {
        if (rateLimitWaits < 5) {
          rateLimitWaits++;
          await waitForRateLimit(r, this.log);
          continue;
        }
        if (this.idx < this.models.length - 1) {
          this.log(`model ${m} rate limited, switching to ${this.models[this.idx + 1]}`);
          this.idx++;
          continue;
        }
      }
      const modelProblem = RETRY.includes(r.status) || (r.status === 400 && /model|tool/i.test(r.text));
      if (modelProblem && this.idx < this.models.length - 1) { this.log(`model ${m} failed (${r.status}), switching to ${this.models[this.idx + 1]}`); this.idx++; continue; }
      throw new Error(`${this.label} error ${r.status}: ${r.text.slice(0, 300)}`);
    }
  }
  addResults(rs) {
    for (const x of rs) {
      const content = JSON.stringify(x.result);
      this.messages.push({ role: 'tool', tool_call_id: x.id,
        content: content.length > 3000 ? `${content.slice(0, 3000 - TRUNCATED.length)}${TRUNCATED}` : content });
    }
  }
  nudge(t) { this.messages.push({ role: 'user', content: t }); }
}

export function pickProvider(env, log) {
  const want = env.LLM_PROVIDER || (env.GROQ_API_KEY ? 'groq' : env.OPENROUTER_API_KEY ? 'openrouter' : env.LLM_API_KEY ? 'custom' : env.GEMINI_API_KEY ? 'gemini' : '');
  if (want === 'gemini' && env.GEMINI_API_KEY) return new GeminiProvider(env.GEMINI_API_KEY, log);
  if (want === 'groq' && env.GROQ_API_KEY) return new OpenAIProvider({ label: 'Groq', base: 'https://api.groq.com/openai/v1', key: env.GROQ_API_KEY, log,
    preferred: ['llama-3.3-70b-versatile', 'openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3-32b', 'meta-llama/llama-4-scout-17b-16e-instruct'] });
  if (want === 'openrouter' && env.OPENROUTER_API_KEY) return new OpenAIProvider({ label: 'OpenRouter', base: 'https://openrouter.ai/api/v1', key: env.OPENROUTER_API_KEY, log });
  if (want === 'custom' && env.LLM_API_KEY && env.LLM_BASE_URL) return new OpenAIProvider({ label: 'Custom', base: env.LLM_BASE_URL, key: env.LLM_API_KEY, log });
  throw new Error('No API key found. Add ONE of these to your .env file:\n  GROQ_API_KEY=...        (free: console.groq.com/keys)\n  OPENROUTER_API_KEY=...  (free models: openrouter.ai/keys)\n  GEMINI_API_KEY=...');
}
