import 'dotenv/config';
import { request } from 'undici';
import { loadConfig } from './config.js';
import { AccountPool } from './pool/account-pool.js';
import { TokenRefresher } from './pool/refresher.js';
import { QuotaManager } from './pool/quota-manager.js';
import { RequestExecutor } from './pool/breaker.js';
import { createServer } from './gateway/server.js';
import { destroyAllDispatchers, getOrCreateDispatcher, sharedEgressWarning } from './pool/dispatcher.js';

async function main() {
  console.log('====================================================');
  console.log('       🚀 Antigravity Multi-Account Proxy           ');
  console.log('====================================================');

  const config = loadConfig();
  const pool = new AccountPool(config.routingStrategy || 'zero-waste', undefined, config.activeConversationTtlMs);
  const refresher = new TokenRefresher(pool, config);
  const quotaManager = new QuotaManager(pool, config);
  const executor = new RequestExecutor(pool, refresher, config, quotaManager);

  // 启动后台 Token 自动保活协程与额度监控协程
  refresher.start();
  quotaManager.startBackgroundWorker();

  // 账号隔离提醒：共用出口 IP 是上游把多账号关联成同一实体的主要途径
  const sharedEgress = sharedEgressWarning(
    pool.getAllAccounts().map(account => account.proxyUrl),
    config.defaultProxyUrl
  );

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

    // 出口连通性与节点地区自动探测
    const activeProxy = config.defaultProxyUrl;
    // A bad proxy URL must not abort the boot: the dashboard is the place to
    // fix it, and every request already reports the same clear error.
    void (async () => {
      try {
        const probeDisp = activeProxy ? getOrCreateDispatcher(activeProxy) : undefined;
        const response = await request('https://ipinfo.io/json', {
          dispatcher: probeDisp,
          headersTimeout: 5000,
          bodyTimeout: 5000
        });
        if (response.statusCode !== 200) throw new Error(`ipinfo.io returned HTTP ${response.statusCode}`);
        const info = (await response.body.json()) as { ip?: string; country?: string; city?: string; org?: string };
        const region = [info.country, info.city].filter(Boolean).join(' - ') || '未知';
        const isGoogleBlocked = ['HK', 'CN', 'MO', 'RU', 'IR'].includes(info.country || '');

        console.log(`\n🌐 [代理出口诊断]:`);
        console.log(`   📡 本地代理: ${activeProxy || 'direct'}`);
        console.log(`   🌍 出口 IP:   ${info.ip || '未知'} (${region}) [${info.org || ''}]`);
        if (isGoogleBlocked) {
          console.log(`   🚨 地区警告:  当前出口为 ${info.country}，Google Gemini API 明确禁止此地区！请在 Clash 中切换为 US/JP/SG 节点！`);
        } else {
          console.log(`   ✅ 状态良好:  Google Gemini API 支持该地区 (${info.country || '未知'})`);
        }

        if (sharedEgress) {
          console.warn(`\n⚠️  [账号隔离提醒] ${sharedEgress}。`);
          console.warn(`   当前节点地区: ${region} (出口 IP: ${info.ip || '未知'})`);
          console.warn('   共用出口 IP / 连接池 / TLS 会话会让 Google 把多个账号关联为同一实体，');
          console.warn('   建议在 Web 控制台为每个账号单独配置出口代理 (proxyUrl)，实现真正的账号隔离。\n');
        }
      } catch (err: any) {
        console.warn(`\n⚠️ [代理出口诊断]: 无法检测当前节点地区 (${err.message})。`);
        if (sharedEgress) {
          console.warn(`\n⚠️  [账号隔离提醒] ${sharedEgress}。`);
          console.warn('   当前节点地区: 未知 (出口地区检测失败)');
          console.warn('   共用出口 IP / 连接池 / TLS 会话会让 Google 把多个账号关联为同一实体，');
          console.warn('   建议在 Web 控制台为每个账号单独配置出口代理 (proxyUrl)，实现真正的账号隔离。\n');
        }
      }
    })();

    console.log('\n====================================================\n');
  } catch (err) {
    console.error('Fatal error starting server:', err);
    process.exit(1);
  }

  const handleShutdown = async (signal: string) => {
    console.log(`\nReceived ${signal}, gracefully shutting down...`);
    refresher.stop();
    quotaManager.stop();
    await server.close();
    pool.dispose();
    destroyAllDispatchers();
    process.exit(0);
  };

  process.on('SIGINT', () => handleShutdown('SIGINT'));
  process.on('SIGTERM', () => handleShutdown('SIGTERM'));
}

main().catch(err => {
  console.error('Unhandled error in main:', err);
});
