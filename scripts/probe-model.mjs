// Throwaway: prove the local reply model actually generates text.
// Written to a file because inline JSON through `cmd /C` gets its quotes eaten.
const base = process.env.AI_BASE_URL || 'http://127.0.0.1:11434/v1';
const model = process.env.AI_MODEL || 'qwen2.5:3b-instruct';

const res = await fetch(`${base}/chat/completions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    model,
    messages: [
      { role: 'system', content: 'You rewrite rough speech into clean prose. Reply with only the rewrite.' },
      { role: 'user', content: 'so um i was thinking we could like maybe push the thing to friday' },
    ],
    max_tokens: 120,
    temperature: 0.2,
  }),
});

console.log('HTTP', res.status);
const body = await res.json();
const text = body?.choices?.[0]?.message?.content;
console.log('MODEL', body?.model);
console.log('REPLY:', text ?? JSON.stringify(body));
