import { AccountPool } from '../src/pool/account-pool.js';

async function verifyAllUpstreamModels() {
  const pool = new AccountPool();
  const acc = pool.acquireAccount();
  if (!acc) {
    console.error('No account available');
    return;
  }
  console.log('Testing with account:', acc.email);

  const candidates = [
    // Claude Opus
    'claude-opus-4-6-thinking',
    'claude-opus-4-6',
    'claude-opus-4-5',
    'claude-opus-4',
    // Claude Sonnet
    'claude-sonnet-4-6',
    'claude-sonnet-4-5',
    'claude-sonnet-4',
    // Claude Haiku
    'claude-haiku-4-5',
    // Gemini 3.8
    'gemini-3.8-flash-high',
    'gemini-3.8-flash-medium',
    'gemini-3.8-flash-low',
    // Gemini 3.7
    'gemini-3.7-flash-high',
    'gemini-3.7-flash-medium',
    'gemini-3.7-flash-low',
    // Gemini 3.6
    'gemini-3.6-flash-high',
    'gemini-3.6-flash-medium',
    'gemini-3.6-flash-low',
    // Gemini 3.1 Pro
    'gemini-3.1-pro-high',
    'gemini-3.1-pro-low',
    'gemini-pro-agent',
    // Gemini 2.5
    'gemini-2.5-pro',
    'gemini-2.5-flash',
    // GPT
    'gpt-oss-120b-medium',
    'gpt-oss-120b-high',
    'gpt-oss-120b-low',
    'gpt-oss-20b'
  ];

  console.log('\n--- VERIFYING REAL UPSTREAM MODELS ON GOOGLE CLOUDCODE ---');
  for (const model of candidates) {
    await new Promise(r => setTimeout(r, 1200)); // avoid 429 burst
    try {
      const res = await fetch('https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + acc.accessToken,
          'Content-Type': 'application/json',
          'User-Agent': 'antigravity/2.14.0'
        },
        body: JSON.stringify({
          project: 'aicode-consumers',
          model: model,
          request: {
            contents: [{ role: 'user', parts: [{ text: '1' }] }],
            generationConfig: { maxOutputTokens: 10 }
          }
        })
      });
      const text = await res.text();
      const isOk = res.status === 200;
      const is429 = res.status === 429;
      const is400 = res.status === 400;
      const is404 = res.status === 404;

      if (isOk) {
        console.log(`✅ [${model}]: 200 OK (Supported & Available)`);
      } else if (is429) {
        console.log(`⚠️ [${model}]: 429 Rate limited (Exists upstream)`);
      } else if (is404) {
        console.log(`❌ [${model}]: 404 NOT FOUND (Does not exist)`);
      } else if (is400) {
        console.log(`❌ [${model}]: 400 Bad Request: ${text.substring(0, 80)}`);
      } else {
        console.log(`❓ [${model}]: ${res.status}: ${text.substring(0, 80)}`);
      }
    } catch (e) {
      console.log(`💥 [${model}]: ${e.message}`);
    }
  }
}

verifyAllUpstreamModels().catch(console.error);
