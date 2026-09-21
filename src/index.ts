import 'dotenv/config';
import { loadConfig } from './config.js';
import { AccountPool } from './pool/account-pool.js';
import { TokenRefresher } from './pool/refresher.js';
import { QuotaManager } from './pool/quota-manager.js';
import { RequestExecutor } from './pool/breaker.js';
import { createServer } from './gateway/server.js';

async function main() {
  console.log('====================================================');
  console.log('       🚀 Antigravity Multi-Account Proxy           ');
  console.log('====================================================');

  const config = loadConfig();
  const pool = new AccountPool(config.routingStrategy || 'zero-waste');
  const refresher = new TokenRefresher(pool, config);
  const quotaManager = new QuotaManager(pool);
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
    console.log(`   👉 Model List:       http://localhost:${config.port}/v1/models`);
    console.log(`   🔑 Client API Key:   ${config.apiMasterKey}`);
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
