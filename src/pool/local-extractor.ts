import { execSync } from 'child_process';
import path from 'path';

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
