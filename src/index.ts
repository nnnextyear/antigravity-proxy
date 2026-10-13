import 'dotenv/config';
import { request } from 'undici';
import { loadConfig } from './config.js';
import { AccountPool } from './pool/account-pool.js';
import { TokenRefresher } from './pool/refresher.js';
import { QuotaManager } from './pool/quota-manager.js';
import { RequestExecutor } from './pool/breaker.js';
import { createServer } from './gateway/server.js';
import { getOrCreateDispatcher } from './pool/dispatcher.js';

async function main() {
  console.log('====================================================');
  console.log('       🚀 Antigravity Multi-Account Proxy           ');
  console.log('====================================================');

  const config = loadConfig();
  const pool = new AccountPool(config.routingStrategy || 'zero-waste');
  const refresher = new TokenRefresher(pool, config);
  const quotaManager = new QuotaManager(pool, config);
  const executor = new RequestExecutor(pool, refresher, config, quotaManager);

  // 启动后台 Token 自动保活协程与额度监控协程
  refresher.start();
  quotaManager.startBackgroundWorker();

  // 启动 Web 服务
  const server = await createServer(config, pool, refresher, executor, quotaManager);

  try {
    const address = await server.listen({
      port: config.port,
      host: config.host
    });

    console.log(`\n✅ Proxy Service is running at: ${address}`);
    console.log(`\n📌 [Web Management Console]:`);
    console.log(`   👉 http://localhost:${config.port}/admin`);
    console.log(`   🔑 Default Admin Password: ${config.adminPassword}`);
    console.log(`\n📌 [OpenAI Compatible Endpoints]:`);
    console.log(`   👉 Chat Completions: http://localhost:${config.port}/v1/chat/completions`);
    console.log(`   👉 Responses API:    http://localhost:${config.port}/v1/responses`);
    console.log(`   👉 Model List:       http://localhost:${config.port}/v1/models`);
    console.log(`   🔑 Client API Key:   ${config.apiMasterKey}`);

    // 出口代理连通性与节点地区自动探测
    const activeProxy = config.defaultProxyUrl || process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
    if (activeProxy) {
      const probeDisp = getOrCreateDispatcher(activeProxy, { timeoutMs: 5000 });
      request('https://ipinfo.io/json', { dispatcher: probeDisp, headersTimeout: 5000, bodyTimeout: 5000 })
        .then(async r => {
          if (r.statusCode === 200) {
            const info = (await r.body.json()) as any;
            const isGoogleBlocked = ['HK', 'CN', 'MO', 'RU', 'IR'].includes(info.country);
            console.log(`\n🌐 [代理出口诊断]:`);
            console.log(`   📡 本地代理: ${activeProxy}`);
            console.log(`   🌍 出口 IP:   ${info.ip} (${info.country} - ${info.city || 'Unknown'}) [${info.org || ''}]`);
            if (isGoogleBlocked) {
              console.log(`   🚨 地区警告:  当前出口为 ${info.country}，Google Gemini API 明确禁止此地区！请在 Clash 中切换为 US/JP/SG 节点！`);
            } else {
              console.log(`   ✅ 状态良好:  Google Gemini API 支持该地区 (${info.country})`);
            }
          }
        })
        .catch(err => {
          console.warn(`\n⚠️ [代理出口诊断]: 无法通过代理 ${activeProxy} 访问外网 (${err.message})，请确保 Clash 正在运行且端口正确。`);
        });
    }

    console.log('\n====================================================\n');
  } catch (err) {
    console.error('Fatal error starting server:', err);
    process.exit(1);
  }

  const handleShutdown = async (signal: string) => {
    console.log(`\nReceived ${signal}, gracefully shutting down...`);
    refresher.stop();
    await server.close();
    process.exit(0);
  };

  process.on('SIGINT', () => handleShutdown('SIGINT'));
  process.on('SIGTERM', () => handleShutdown('SIGTERM'));
}

main().catch(err => {
  console.error('Unhandled error in main:', err);
});
