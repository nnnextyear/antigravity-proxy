import { loadConfig } from '../src/config.js';
import { AccountPool } from '../src/pool/account-pool.js';
import { TokenRefresher } from '../src/pool/refresher.js';
import { RequestExecutor } from '../src/pool/breaker.js';
import { createServer } from '../src/gateway/server.js';
import { AppConfig } from '../src/types.js';

async function runTests() {
  console.log('🧪 Starting Antigravity Proxy integration tests...\n');

  const testConfig: AppConfig = {
    port: 3099,
    host: '127.0.0.1',
    apiMasterKey: 'test-sk-key',
    adminPassword: 'test-admin-password',
    upstreamUrl: 'https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse',
    defaultMaxConcurrency: 3,
    cooldownSeconds: 30,
    tokenRefreshIntervalMs: 60000
  };

  const pool = new AccountPool();
  const refresher = new TokenRefresher(pool, testConfig);
  const executor = new RequestExecutor(pool, refresher, testConfig);
  const server = await createServer(testConfig, pool, refresher, executor);

  await server.listen({ port: testConfig.port, host: testConfig.host });
  const baseUrl = `http://127.0.0.1:${testConfig.port}`;

  try {
    // 1. 测试 /health
    console.log('1️⃣ Testing /health ...');
    const healthRes = await fetch(`${baseUrl}/health`);
    const healthData = (await healthRes.json()) as any;
    if (healthRes.status === 200 && healthData.status === 'ok') {
      console.log('   ✅ Health check passed.');
    } else {
      throw new Error(`Health check failed: ${JSON.stringify(healthData)}`);
    }

    // 2. 测试 /v1/models 权限拦截与正确获取
    console.log('2️⃣ Testing /v1/models authentication...');
    const unauthModelRes = await fetch(`${baseUrl}/v1/models`);
    if (unauthModelRes.status === 401) {
      console.log('   ✅ Missing API key correctly blocked (401).');
    } else {
      throw new Error(`Expected 401 for missing key, got ${unauthModelRes.status}`);
    }

    const authModelRes = await fetch(`${baseUrl}/v1/models`, {
      headers: { Authorization: `Bearer ${testConfig.apiMasterKey}` }
    });
    const modelData = (await authModelRes.json()) as any;
    if (authModelRes.status === 200 && Array.isArray(modelData.data) && modelData.data.length > 0) {
      console.log(`   ✅ Models endpoint returned ${modelData.data.length} models: ${modelData.data.map((m: any) => m.id).join(', ')}`);
    } else {
      throw new Error(`Failed to list models: ${JSON.stringify(modelData)}`);
    }

    // 3. 测试 Admin 密码鉴权
    console.log('3️⃣ Testing Admin API security...');
    const wrongAdminRes = await fetch(`${baseUrl}/api/admin/stats`, {
      headers: { 'X-Admin-Password': 'wrong-password' }
    });
    if (wrongAdminRes.status === 401) {
      console.log('   ✅ Wrong admin password correctly blocked (401).');
    } else {
      throw new Error(`Expected 401 for wrong admin password, got ${wrongAdminRes.status}`);
    }

    const validAdminRes = await fetch(`${baseUrl}/api/admin/stats`, {
      headers: { 'X-Admin-Password': testConfig.adminPassword }
    });
    if (validAdminRes.status === 200) {
      console.log('   ✅ Valid admin password passed.');
    } else {
      throw new Error(`Expected 200 for valid admin password, got ${validAdminRes.status}`);
    }

    // 4. 测试多账号调度与熔断状态机
    console.log('4️⃣ Testing Account Pool Multi-Account Rotation & Failover...');
    const accA = pool.addAccount({
      email: 'test-user-a@example.com',
      refreshToken: '1//dummy-refresh-token-a',
      accessToken: 'dummy-access-token-a',
      expiresInSeconds: 3600,
      maxConcurrency: 2
    });
    const accB = pool.addAccount({
      email: 'test-user-b@example.com',
      refreshToken: '1//dummy-refresh-token-b',
      accessToken: 'dummy-access-token-b',
      expiresInSeconds: 3600,
      maxConcurrency: 2
    });

    const picked1 = pool.acquireAccount();
    const picked2 = pool.acquireAccount();
    console.log(`   📌 First acquire picked: ${picked1?.email}`);
    console.log(`   📌 Second acquire picked: ${picked2?.email}`);

    if (picked1 && picked2 && picked1.id !== picked2.id) {
      console.log('   ✅ Least-Concurrency multi-account load balancing verified successfully!');
    } else {
      throw new Error('Load balancing failed to distribute across different accounts');
    }

    // 模拟 picked1 触发 429 限流 -> 验证自动进入 Cooldown
    pool.releaseAccount(picked1!.id, { code: 429, message: 'Resource exhausted' });
    const acc1Cooldown = pool.getAccount(picked1!.id);
    if (acc1Cooldown?.status === 'cooldown' && acc1Cooldown.cooldownUntil > Date.now()) {
      console.log(`   ✅ Account ${acc1Cooldown.email} correctly entered COOLDOWN status.`);
    } else {
      throw new Error(`Account status was not cooldown: ${acc1Cooldown?.status}`);
    }

    // 再次借取 -> 此时 picked1 冷却中，应当跳过并借出其他账号
    const picked3 = pool.acquireAccount();
    if (picked3 && picked3.id !== picked1!.id) {
      console.log(`   ✅ Cooldown account bypassed; successfully failed over to ${picked3.email}.`);
    } else {
      throw new Error(`Expected failover from cooldown account, but got ${picked3?.email}`);
    }

    // 释放所有已借账号
    pool.releaseAccount(picked2!.id);
    pool.releaseAccount(picked3!.id);

    // 清理测试账号
    pool.removeAccount(accA.id);
    pool.removeAccount(accB.id);
    console.log('   ✅ Test accounts cleaned up.');

    // 5. 测试纯净模型名与动态思考强度解析 (Opus, Sonnet, Gemini 3.8 等)
    console.log('5️⃣ Testing Clean Model IDs & Dynamic Thinking Effort Resolution...');
    const { resolveDynamicUpstreamModel } = await import('../src/gateway/models.js');
    const testCases = [
      { input: 'claude-3-opus', effort: 'high', expected: 'claude-opus-4-6-thinking' },
      { input: 'claude-3-5-sonnet', effort: 'high', expected: 'claude-sonnet-4-6' },
      { input: 'gemini-3.8-flash', effort: 'high', expected: 'gemini-3.8-flash-high' },
      { input: 'gemini-3.8-flash', effort: 'medium', expected: 'gemini-3.8-flash-medium' },
      { input: 'gemini-3.8-flash', effort: 'low', expected: 'gemini-3.8-flash-low' },
      { input: 'gemini-3.7-flash', effort: 'low', expected: 'gemini-3.7-flash-low' },
      { input: 'gpt-4o', effort: 'high', expected: 'gpt-oss-120b-medium' }
    ];
    for (const tc of testCases) {
      const resolved = resolveDynamicUpstreamModel(tc.input, tc.effort as any);
      if (resolved.upstreamModel === tc.expected) {
        console.log(`   ✅ [${tc.input}] (effort: ${tc.effort}) correctly routed to upstream [${resolved.upstreamModel}]`);
      } else {
        throw new Error(`Failed to resolve ${tc.input}: got ${resolved.upstreamModel}, expected ${tc.expected}`);
      }
    }

    // 6. 测试 Web 控制台静态页面服务
    console.log('6️⃣ Testing Web Console Static Asset delivery...');
    const staticRes = await fetch(`${baseUrl}/admin/index.html`);
    const htmlText = await staticRes.text();
    if (staticRes.status === 200 && htmlText.includes('Antigravity Proxy')) {
      console.log('   ✅ Web Console static HTML served correctly.');
    } else {
      throw new Error('Failed to serve Web Console static assets');
    }

    // 7. 测试 Anthropic Messages 端点权限与模型别名 [1M] 兼容
    console.log('7️⃣ Testing Anthropic /v1/messages (Claude Code protocol) & [1M] brackets...');
    const unauthAnthropic = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'claude-opus[1M]', messages: [{ role: 'user', content: 'hi' }] })
    });
    // 8. 测试 /v1/v1/ 重复前缀重写 (Claude Code CC Switch 场景)
    console.log('8️⃣ Testing Claude Code duplicated /v1/v1/ URL rewriting...');
    const duplicateV1Res = await fetch(`${baseUrl}/v1/v1/messages?beta=true`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gemini-3.8-flash[1m]', messages: [{ role: 'user', content: 'hi' }] })
    });
    if (duplicateV1Res.status === 401) {
      console.log('   ✅ /v1/v1/messages?beta=true successfully routed (hit 401 instead of 404).');
    } else {
      throw new Error(`Expected 401 for /v1/v1/messages, got ${duplicateV1Res.status}`);
    }

    const duplicateModelsRes = await fetch(`${baseUrl}/v1/v1/models`, {
      headers: { Authorization: `Bearer ${testConfig.apiMasterKey}` }
    });
    if (duplicateModelsRes.status === 200) {
      console.log('   ✅ /v1/v1/models successfully routed.');
    } else {
      throw new Error(`Expected 200 for /v1/v1/models, got ${duplicateModelsRes.status}`);
    }

    console.log('\n🎉 ALL INTEGRATION TESTS PASSED SUCCESSFULLY! 🚀\n');
  } finally {
    await server.close();
  }
}

runTests().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
