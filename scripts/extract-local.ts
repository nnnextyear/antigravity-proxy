import { execSync } from 'child_process';
import path from 'path';
import { AccountPool } from '../src/pool/account-pool.js';
import { TokenRefresher } from '../src/pool/refresher.js';
import { loadConfig } from '../src/config.js';

export function extractFromWindowsCredential(): {
  email?: string;
  refreshToken?: string;
  accessToken?: string;
  expiry?: string;
} | null {
  const psPath = path.resolve(process.cwd(), 'scripts', 'read-cred.ps1');

  try {
    const output = execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${psPath}"`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore']
    }).trim();

    if (!output) return null;
    const parsed = JSON.parse(output);
    const tokenObj = parsed.token || {};

    let email = 'antigravity-local@google.com';
    if (parsed.id_token) {
      try {
        const payloadBase64 = parsed.id_token.split('.')[1];
        const payloadJson = Buffer.from(payloadBase64, 'base64').toString('utf-8');
        const idData = JSON.parse(payloadJson);
        if (idData.email) email = idData.email;
      } catch {}
    }

    return {
      email,
      refreshToken: tokenObj.refresh_token,
      accessToken: tokenObj.access_token,
      expiry: tokenObj.expiry
    };
  } catch (err: any) {
    console.error('Failed to extract Windows Credential:', err.message);
    return null;
  }
}

async function main() {
  console.log('🔍 Scanning local Antigravity credentials from Windows Credential Manager...');
  const creds = extractFromWindowsCredential();

  if (!creds || !creds.refreshToken) {
    console.error('❌ Could not find Antigravity credentials. Please make sure Antigravity IDE is logged in.');
    process.exit(1);
  }

  console.log(`✅ Found Antigravity Account: ${creds.email}`);
  console.log(`   Refresh Token: ${creds.refreshToken.substring(0, 10)}...${creds.refreshToken.substring(creds.refreshToken.length - 6)}`);

  const pool = new AccountPool();
  const existing = pool.getAllAccounts().find(a => a.email === creds.email);

  if (existing) {
    console.log(`🔄 Account already exists in pool (${existing.id}), updating tokens...`);
    pool.updateAccount(existing.id, {
      refreshToken: creds.refreshToken,
      accessToken: creds.accessToken,
      status: 'active',
      cooldownUntil: 0
    });
  } else {
    const newAcc = pool.addAccount({
      email: creds.email,
      refreshToken: creds.refreshToken,
      accessToken: creds.accessToken,
      maxConcurrency: 5
    });
    console.log(`🎉 Successfully added local Antigravity account to pool! Account ID: ${newAcc.id}`);
  }

  const config = loadConfig();
  const refresher = new TokenRefresher(pool, config);
  console.log('Testing token validity with Google upstream...');
  const acc = pool.getAllAccounts().find(a => a.email === creds.email)!;
  const ok = await refresher.refreshSingleAccount(acc);
  if (ok) {
    console.log('✅ Google OAuth test passed! Token is active and ready to serve.');
  } else {
    console.warn('⚠️ Token test returned error, please check network connection or proxy.');
  }
}

main().catch(console.error);
