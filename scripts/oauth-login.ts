import http from 'http';
import { request } from 'undici';
import { AccountPool } from '../src/pool/account-pool.js';
import { loadConfig, DEFAULT_OAUTH_CLIENT_ID, DEFAULT_OAUTH_CLIENT_SECRET } from '../src/config.js';

const config = loadConfig();
const CLIENT_ID = config.oauthClientId || DEFAULT_OAUTH_CLIENT_ID;
const CLIENT_SECRET = config.oauthClientSecret || DEFAULT_OAUTH_CLIENT_SECRET;
const PORT = 4567;
const REDIRECT_URI = `http://127.0.0.1:${PORT}/callback`;

const SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'openid'
].join(' ');

async function main() {
  console.log('====================================================');
  console.log('       🔑 Antigravity Google OAuth Login Wizard     ');
  console.log('====================================================\n');

  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?` + new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: SCOPES,
    access_type: 'offline',
    prompt: 'consent'
  }).toString();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '', `http://127.0.0.1:${PORT}`);

    if (url.pathname === '/callback') {
      const code = url.searchParams.get('code');
      const err = url.searchParams.get('error');

      if (err) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<h2>❌ 授权失败</h2><p>${err}</p>`);
        return;
      }

      if (!code) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<h2>❌ 缺失 code 参数</h2>`);
        return;
      }

      console.log('📥 接收到授权码 Code，正在向 Google 换取 Token...');

      try {
        const tokenRes = await request('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
            code,
            grant_type: 'authorization_code',
            redirect_uri: REDIRECT_URI
          }).toString()
        });

        const tokenData = (await tokenRes.body.json()) as any;
        if (!tokenData.refresh_token) {
          throw new Error(tokenData.error_description || tokenData.error || '未返回 refresh_token，请重新以 prompt=consent 授权');
        }

        // 解析 ID Token 获取邮箱
        let email = 'unknown@gmail.com';
        if (tokenData.id_token) {
          try {
            const payload = JSON.parse(Buffer.from(tokenData.id_token.split('.')[1], 'base64').toString('utf-8'));
            if (payload.email) email = payload.email;
          } catch {}
        }

        const config = loadConfig();
        let syncedWithServer = false;

        // 优先尝试直接通知正在运行的后台服务 (实现零时差热加载与即时查额度)
        try {
          const checkRes = await fetch(`http://127.0.0.1:${config.port}/health`, { signal: AbortSignal.timeout(1000) });
          if (checkRes.ok) {
            const addRes = await fetch(`http://127.0.0.1:${config.port}/api/admin/accounts`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'X-Admin-Password': config.adminPassword
              },
              body: JSON.stringify({
                email,
                refreshToken: tokenData.refresh_token,
                accessToken: tokenData.access_token,
                expiresInSeconds: tokenData.expires_in || 3600,
                maxConcurrency: 5
              })
            });
            if (addRes.ok) {
              syncedWithServer = true;
              console.log(`🎉 成功同步录入正在运行的 Antigravity 代理服务并加入活跃轮询池！`);
            }
          }
        } catch {}

        if (!syncedWithServer) {
          // 若后台服务未运行，直接写入本地持久化账号池
          const pool = new AccountPool();
          const existing = pool.getAllAccounts().find(a => a.email === email);

          if (existing) {
            pool.updateAccount(existing.id, {
              refreshToken: tokenData.refresh_token,
              accessToken: tokenData.access_token,
              accessTokenExpiresAt: Date.now() + (tokenData.expires_in || 3600) * 1000,
              status: 'active',
              cooldownUntil: 0
            });
            console.log(`✅ 已更新现有账号: ${email} (${existing.id})`);
          } else {
            const newAcc = pool.addAccount({
              email,
              refreshToken: tokenData.refresh_token,
              accessToken: tokenData.access_token,
              expiresInSeconds: tokenData.expires_in || 3600,
              maxConcurrency: 5
            });
            console.log(`🎉 成功添加新账号: ${email} (账号 ID: ${newAcc.id})`);
          }
        }

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`
          <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; text-align: center; margin-top: 60px;">
            <h1 style="color: #10b981;">🎉 登录与授权成功！</h1>
            <p style="font-size: 16px; color: #374151;">账号 <strong>${email}</strong> 的 Refresh Token 已自动成功加入 Antigravity 代理账号池。</p>
            <p style="color: #6b7280; font-size: 14px;">您可以关闭此页面，返回控制台查看。</p>
          </div>
        `);

        setTimeout(() => {
          server.close();
          console.log('\n✨ 授权流程完成，向导服务已自动退出。\n');
          process.exit(0);
        }, 1500);

      } catch (e: any) {
        console.error('❌ Token 交换失败:', e.message);
        res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<h2>❌ Token 交换失败</h2><p>${e.message}</p>`);
      }
    }
  });

  server.listen(PORT, '127.0.0.1', () => {
    console.log(`👉 请在浏览器中打开下方链接完成 Google 账号授权：\n`);
    console.log(`🔗 \x1b[36m${authUrl}\x1b[0m\n`);
    console.log(`⏳ 等待浏览器授权回调中 (监听: http://127.0.0.1:${PORT}/callback)...`);
    console.log(`（可按 Ctrl+C 取消）\n`);
  });
}

main().catch(console.error);
