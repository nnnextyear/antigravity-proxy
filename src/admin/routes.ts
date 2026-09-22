import http from 'http';
import { randomUUID } from 'crypto';
import { request } from 'undici';
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { AccountPool } from '../pool/account-pool.js';
import { TokenRefresher } from '../pool/refresher.js';
import { QuotaManager } from '../pool/quota-manager.js';
import { AppConfig } from '../types.js';
import { saveConfig } from '../config.js';
import { DEFAULT_OAUTH_CLIENT_ID, DEFAULT_OAUTH_CLIENT_SECRET } from '../config.js';
import { extractFromWindowsCredential } from '../pool/local-extractor.js';

export function registerAdminRoutes(
  app: FastifyInstance,
  pool: AccountPool,
  refresher: TokenRefresher,
  config: AppConfig,
  quotaManager?: QuotaManager
) {
  const oauthPort = 4567;
  const oauthRedirectUri = `http://127.0.0.1:${oauthPort}/callback`;
  const oauthScopes = [
    'https://www.googleapis.com/auth/cloud-platform',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile',
    'openid'
  ].join(' ');
  let oauthSession: { server: http.Server; state: string; authUrl: string; expiresAt: number } | null = null;

  const closeOauthSession = () => {
    if (!oauthSession) return;
    oauthSession.server.close();
    oauthSession = null;
  };

  const readEmailFromIdToken = (idToken?: string) => {
    if (!idToken) return 'unknown@gmail.com';
    try {
      const payload = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString('utf-8'));
      return payload.email || 'unknown@gmail.com';
    } catch {
      return 'unknown@gmail.com';
    }
  };

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

  // 4.1 更新指定账号配置 (出口代理 proxyUrl、并发限制 maxConcurrency 等)
  app.put('/api/admin/accounts/:id', { preHandler: [requireAdminAuth] }, async (req: FastifyRequest, reply) => {
    const params = req.params as { id: string };
    const body = req.body as any;
    const acc = pool.getAccount(params.id);
    if (!acc) {
      return reply.status(404).send({ error: 'Account not found' });
    }

    const updates: any = {};
    if (body.proxyUrl !== undefined) {
      const raw = String(body.proxyUrl || '').trim();
      if (!raw || raw.toLowerCase() === 'direct' || raw === '直连') {
        updates.proxyUrl = undefined;
      } else {
        let norm = raw;
        if (!/^https?:\/\/|^socks5?:\/\//i.test(norm)) {
          norm = 'http://' + norm;
        }
        updates.proxyUrl = norm;
      }
    }
    if (body.maxConcurrency !== undefined) {
      const mc = Number(body.maxConcurrency);
      if (!isNaN(mc) && mc >= 1) updates.maxConcurrency = Math.min(50, mc);
    }

    const updated = pool.updateAccount(params.id, updates);
    return { success: true, message: '账号配置已成功更新', account: updated };
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

  // 6.1 手动启用或停用账号。停用账号保留凭据与历史数据，但不会再参与调度。
  app.put('/api/admin/accounts/:id/status', { preHandler: [requireAdminAuth] }, async (req: FastifyRequest, reply) => {
    const params = req.params as { id: string };
    const body = req.body as { status?: string };
    if (body.status !== 'active' && body.status !== 'disabled') {
      return reply.status(400).send({ error: 'status must be active or disabled' });
    }

    const acc = pool.getAccount(params.id);
    if (!acc) {
      return reply.status(404).send({ error: 'Account not found' });
    }

    acc.status = body.status;
    acc.cooldownUntil = 0;
    if (body.status === 'active') acc.lastError = undefined;
    pool.saveAccounts();
    return { success: true, message: body.status === 'disabled' ? '账号已停用，不会参与后续调度' : '账号已重新启用', account: acc };
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
      defaultProxyUrl: config.defaultProxyUrl,
      hasOauthCredentials: Boolean(config.oauthClientId)
    };
  });

  app.put('/api/admin/config', { preHandler: [requireAdminAuth] }, async (req: FastifyRequest, reply) => {
    const body = req.body as Partial<AppConfig>;
    if (body.apiMasterKey) config.apiMasterKey = body.apiMasterKey;
    if (body.adminPassword) config.adminPassword = body.adminPassword;
    if (body.upstreamUrl) config.upstreamUrl = body.upstreamUrl;
    if (body.cooldownSeconds) config.cooldownSeconds = body.cooldownSeconds;
    if (body.defaultProxyUrl !== undefined) config.defaultProxyUrl = body.defaultProxyUrl;

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

  // 9.1 复用 npm run login 的 Google OAuth 流程，供控制台一键发起授权
  app.post('/api/admin/oauth/start', { preHandler: [requireAdminAuth] }, async (_req, reply) => {
    if (oauthSession && oauthSession.expiresAt > Date.now()) {
      return { authUrl: oauthSession.authUrl, expiresAt: oauthSession.expiresAt };
    }
    closeOauthSession();

    const clientId = config.oauthClientId || DEFAULT_OAUTH_CLIENT_ID;
    const clientSecret = config.oauthClientSecret || DEFAULT_OAUTH_CLIENT_SECRET;
    const state = randomUUID();
    const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({
      client_id: clientId,
      redirect_uri: oauthRedirectUri,
      response_type: 'code',
      scope: oauthScopes,
      access_type: 'offline',
      prompt: 'consent',
      state
    }).toString()}`;

    const callbackServer = http.createServer(async (req, res) => {
      const callbackUrl = new URL(req.url || '/', oauthRedirectUri);
      if (callbackUrl.pathname !== '/callback') {
        res.writeHead(404).end();
        return;
      }

      if (callbackUrl.searchParams.get('state') !== state) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<h2>授权验证失败，请返回控制台重新发起登录。</h2>');
        return;
      }

      const code = callbackUrl.searchParams.get('code');
      const error = callbackUrl.searchParams.get('error');
      if (error || !code) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<h2>Google 授权未完成。</h2><p>请关闭此页面并重试。</p>');
        closeOauthSession();
        return;
      }

      try {
        const tokenRes = await request('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: clientId,
            client_secret: clientSecret,
            code,
            grant_type: 'authorization_code',
            redirect_uri: oauthRedirectUri
          }).toString()
        });
        const tokenData = await tokenRes.body.json() as Record<string, any>;
        if (!tokenData.refresh_token) {
          throw new Error(tokenData.error_description || 'Google 未返回可长期使用的 Refresh Token');
        }

        const email = readEmailFromIdToken(tokenData.id_token);
        const existing = pool.getAllAccounts().find(account => account.email === email);
        const account = existing
          ? pool.updateAccount(existing.id, {
              refreshToken: tokenData.refresh_token,
              accessToken: tokenData.access_token || '',
              accessTokenExpiresAt: Date.now() + (tokenData.expires_in || 3600) * 1000,
              status: 'active',
              cooldownUntil: 0
            })
          : pool.addAccount({
              email,
              refreshToken: tokenData.refresh_token,
              accessToken: tokenData.access_token,
              expiresInSeconds: tokenData.expires_in || 3600,
              maxConcurrency: config.defaultMaxConcurrency
            });

        if (account) refresher.refreshSingleAccount(account).catch(() => {});
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<main style="font-family:system-ui;text-align:center;margin:72px auto;max-width:480px"><h1>授权成功</h1><p>${email} 已加入账号池，可以关闭此页面返回控制台。</p></main>`);
      } catch (error: any) {
        res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<h2>Token 交换失败</h2><p>${String(error.message || error)}</p>`);
      } finally {
        setTimeout(closeOauthSession, 1000);
      }
    });

    try {
      await new Promise<void>((resolve, reject) => {
        callbackServer.once('error', reject);
        callbackServer.listen(oauthPort, '127.0.0.1', () => {
          callbackServer.off('error', reject);
          resolve();
        });
      });
    } catch {
      return reply.status(409).send({ error: `OAuth 回调端口 ${oauthPort} 正在被占用，请先关闭已有的 npm run login 流程` });
    }

    oauthSession = { server: callbackServer, state, authUrl, expiresAt: Date.now() + 10 * 60 * 1000 };
    setTimeout(() => {
      if (oauthSession?.state === state) closeOauthSession();
    }, 10 * 60 * 1000);
    return { authUrl, expiresAt: oauthSession.expiresAt };
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
