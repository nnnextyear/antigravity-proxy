import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { AccountPool } from '../pool/account-pool.js';
import { TokenRefresher } from '../pool/refresher.js';
import { QuotaManager } from '../pool/quota-manager.js';
import { AppConfig } from '../types.js';
import { saveConfig } from '../config.js';
import { extractFromWindowsCredential } from '../pool/local-extractor.js';

export function registerAdminRoutes(
  app: FastifyInstance,
  pool: AccountPool,
  refresher: TokenRefresher,
  config: AppConfig,
  quotaManager?: QuotaManager
) {
  // 管理员鉴权 hook
  const requireAdminAuth = async (req: FastifyRequest, reply: FastifyReply) => {
    const authHeader = req.headers['x-admin-password'] || req.headers['authorization'];
    let providedPass = '';

    if (typeof authHeader === 'string') {
      if (authHeader.startsWith('Bearer ')) {
        providedPass = authHeader.substring(7).trim();
      } else {
        providedPass = authHeader.trim();
      }
    }

    if (!providedPass || providedPass !== config.adminPassword) {
      reply.status(401).send({ error: 'Unauthorized: invalid admin password' });
    }
  };

  // 1. 获取系统统计信息
  app.get('/api/admin/stats', { preHandler: [requireAdminAuth] }, async () => {
    return pool.getStats();
  });

  // 2. 获取所有账号
  app.get('/api/admin/accounts', { preHandler: [requireAdminAuth] }, async () => {
    const list = pool.getAllAccounts().map(acc => ({
      ...acc,
      refreshTokenMasked: acc.refreshToken
        ? `${acc.refreshToken.substring(0, 6)}...${acc.refreshToken.substring(acc.refreshToken.length - 4)}`
        : '',
      accessTokenMasked: acc.accessToken
        ? `${acc.accessToken.substring(0, 10)}...`
        : ''
    }));
    return { accounts: list };
  });

  // 3. 添加账号
  app.post('/api/admin/accounts', { preHandler: [requireAdminAuth] }, async (req: FastifyRequest, reply) => {
    const body = req.body as any;
    if (!body.email || !body.refreshToken) {
      return reply.status(400).send({ error: 'email and refreshToken are required' });
    }

    const newAcc = pool.addAccount({
      email: body.email,
      refreshToken: body.refreshToken,
      accessToken: body.accessToken,
      expiresInSeconds: body.expiresInSeconds,
      proxyUrl: body.proxyUrl,
      maxConcurrency: body.maxConcurrency
    });

    // 自动尝试触发一次刷新
    refresher.refreshSingleAccount(newAcc).catch(() => {});

    return { message: 'Account added successfully', account: newAcc };
  });

  // 4. 删除账号
  app.delete('/api/admin/accounts/:id', { preHandler: [requireAdminAuth] }, async (req: FastifyRequest, reply) => {
    const params = req.params as { id: string };
    const success = pool.removeAccount(params.id);
    if (!success) {
      return reply.status(404).send({ error: 'Account not found' });
    }
    return { message: 'Account removed successfully' };
  });

  // 5. 手动刷新指定账号
  app.post('/api/admin/accounts/:id/refresh', { preHandler: [requireAdminAuth] }, async (req: FastifyRequest, reply) => {
    const params = req.params as { id: string };
    const acc = pool.getAccount(params.id);
    if (!acc) {
      return reply.status(404).send({ error: 'Account not found' });
    }

    const ok = await refresher.refreshSingleAccount(acc);
    return { success: ok, account: acc };
  });

  // 6. 重置账号状态为 active
  app.post('/api/admin/accounts/:id/reset', { preHandler: [requireAdminAuth] }, async (req: FastifyRequest, reply) => {
    const params = req.params as { id: string };
    const acc = pool.getAccount(params.id);
    if (!acc) {
      return reply.status(404).send({ error: 'Account not found' });
    }

    acc.status = 'active';
    acc.cooldownUntil = 0;
    acc.activeConcurrency = 0;
    acc.lastError = undefined;
    pool.saveAccounts();

    return { message: 'Account status reset to active', account: acc };
  });

  // 7. 查询/刷新指定账号真实额度 (从 Google 官方实时拉取)
  app.post('/api/admin/accounts/:id/quota', { preHandler: [requireAdminAuth] }, async (req: FastifyRequest, reply) => {
    const params = req.params as { id: string };
    const acc = pool.getAccount(params.id);
    if (!acc) {
      return reply.status(404).send({ error: 'Account not found' });
    }
    if (!quotaManager) {
      return reply.status(500).send({ error: 'QuotaManager not initialized' });
    }

    if (!acc.accessToken || Date.now() >= acc.accessTokenExpiresAt) {
      await refresher.refreshSingleAccount(acc);
    }
    const quota = await quotaManager.fetchQuotaForAccount(acc);
    return { success: Boolean(quota), quota, account: acc };
  });

  // 8. 一键刷新全池所有账号的真实额度
  app.post('/api/admin/sync-all-quota', { preHandler: [requireAdminAuth] }, async (req: FastifyRequest, reply) => {
    if (!quotaManager) {
      return reply.status(500).send({ error: 'QuotaManager not initialized' });
    }
    for (const acc of pool.getAllAccounts()) {
      if (!acc.accessToken || Date.now() >= acc.accessTokenExpiresAt) {
        await refresher.refreshSingleAccount(acc).catch(() => {});
      }
    }
    await quotaManager.fetchAllQuotas();
    return { success: true, message: 'All account quotas updated successfully' };
  });

  // 9. 查看与更新系统配置
  app.get('/api/admin/config', { preHandler: [requireAdminAuth] }, async () => {
    return {
      port: config.port,
      apiMasterKey: config.apiMasterKey,
      upstreamUrl: config.upstreamUrl,
      defaultMaxConcurrency: config.defaultMaxConcurrency,
      cooldownSeconds: config.cooldownSeconds,
      hasOauthCredentials: Boolean(config.oauthClientId)
    };
  });

  app.put('/api/admin/config', { preHandler: [requireAdminAuth] }, async (req: FastifyRequest, reply) => {
    const body = req.body as Partial<AppConfig>;
    if (body.apiMasterKey) config.apiMasterKey = body.apiMasterKey;
    if (body.adminPassword) config.adminPassword = body.adminPassword;
    if (body.upstreamUrl) config.upstreamUrl = body.upstreamUrl;
    if (body.cooldownSeconds) config.cooldownSeconds = body.cooldownSeconds;

    saveConfig(config);
    return { message: 'Configuration updated', config };
  });

  // 8. 从本机 Antigravity 登录缓存一键同步凭据
  app.post('/api/admin/sync-local', { preHandler: [requireAdminAuth] }, async (req, reply) => {
    const creds = extractFromWindowsCredential();
    if (!creds || !creds.refreshToken) {
      return reply.status(404).send({ error: '未在本机凭据管理器中找到已登录的 Antigravity 凭据，请先确保 Antigravity 已登录' });
    }

    const email = creds.email || 'antigravity-local@google.com';
    const existing = pool.getAllAccounts().find(a => a.email === email);

    let targetAcc;
    if (existing) {
      targetAcc = pool.updateAccount(existing.id, {
        refreshToken: creds.refreshToken,
        accessToken: creds.accessToken,
        status: 'active',
        cooldownUntil: 0
      });
    } else {
      targetAcc = pool.addAccount({
        email,
        refreshToken: creds.refreshToken,
        accessToken: creds.accessToken,
        maxConcurrency: 5
      });
    }

    if (targetAcc) {
      refresher.refreshSingleAccount(targetAcc).catch(() => {});
    }

    return {
      message: '成功从本机 Antigravity 提取并同步账号',
      account: targetAcc
    };
  });

  // 10. 更新调度策略 (支持 zero-waste / sequential-drain / round-robin)
  app.post('/api/admin/strategy', { preHandler: [requireAdminAuth] }, async (req: FastifyRequest, reply) => {
    const body = req.body as any;
    const strategy = body.strategy;
    if (strategy !== 'zero-waste' && strategy !== 'sequential-drain' && strategy !== 'round-robin') {
      return reply.status(400).send({ error: 'Invalid strategy. Allowed: zero-waste, sequential-drain, round-robin' });
    }
    pool.setRoutingStrategy(strategy);
    config.routingStrategy = strategy;
    saveConfig(config);
    return { success: true, strategy, message: `调度策略已切换为: ${strategy}` };
  });
}
