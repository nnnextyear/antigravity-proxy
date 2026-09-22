let adminPassword = localStorage.getItem('antigravity_admin_pass') || '';
let pollTimer = null;

// DOM 元素
const loginOverlay = document.getElementById('login-overlay');
const adminPassInput = document.getElementById('admin-pass-input');
const btnLogin = document.getElementById('btn-login');
const loginError = document.getElementById('login-error');
const btnLogout = document.getElementById('btn-logout');
const btnRefreshData = document.getElementById('btn-refresh-data');

// 模态弹窗
const addModal = document.getElementById('add-modal');
const btnAddAccountModal = document.getElementById('btn-add-account-modal');
const btnCloseModal = document.getElementById('btn-close-modal');
const btnCancelAdd = document.getElementById('btn-cancel-add');
const btnSubmitAdd = document.getElementById('btn-submit-add');

// 统计指示器
const statTotal = document.getElementById('stat-total');
const statActive = document.getElementById('stat-active');
const statCooldown = document.getElementById('stat-cooldown');
const statDead = document.getElementById('stat-dead');
const statConcurrency = document.getElementById('stat-concurrency');
const statRequests = document.getElementById('stat-requests');
const statClaude5h = document.getElementById('stat-claude-5h');
const statClaudeWeekly = document.getElementById('stat-claude-weekly');
const statGemini5h = document.getElementById('stat-gemini-5h');
const statGeminiWeekly = document.getElementById('stat-gemini-weekly');
const accountsTbody = document.getElementById('accounts-tbody');
const selectStrategy = document.getElementById('select-strategy');

function init() {
  if (adminPassword) {
    loginOverlay.style.display = 'none';
    startDataPolling();
  } else {
    loginOverlay.style.display = 'flex';
  }

  // 绑定事件
  btnLogin.addEventListener('click', handleLogin);
  adminPassInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleLogin();
  });

  btnLogout.addEventListener('click', () => {
    localStorage.removeItem('antigravity_admin_pass');
    adminPassword = '';
    stopDataPolling();
    loginOverlay.style.display = 'flex';
  });

  btnRefreshData.addEventListener('click', () => {
    loadAllData();
  });

  const btnSyncLocal = document.getElementById('btn-sync-local');
  if (btnSyncLocal) {
    btnSyncLocal.addEventListener('click', async () => {
      btnSyncLocal.disabled = true;
      btnSyncLocal.innerText = '⏳ 正在读取...';
      try {
        const res = await apiRequest('/api/admin/sync-local', { method: 'POST' });
        alert(res.message + ': ' + (res.account?.email || ''));
        loadAllData();
      } catch (e) {
        alert('同步失败: ' + e.message);
      } finally {
        btnSyncLocal.disabled = false;
        btnSyncLocal.innerText = '⚡ 一键同步本机账号';
      }
    });
  }

  const btnSyncAllQuota = document.getElementById('btn-sync-all-quota');
  if (btnSyncAllQuota) {
    btnSyncAllQuota.addEventListener('click', async () => {
      btnSyncAllQuota.disabled = true;
      btnSyncAllQuota.innerText = '⏳ 正在刷新...';
      try {
        await apiRequest('/api/admin/sync-all-quota', { method: 'POST' });
        loadAllData();
      } catch (e) {
        alert('刷新额度失败: ' + e.message);
      } finally {
        btnSyncAllQuota.disabled = false;
        btnSyncAllQuota.innerText = '📊 刷新全部额度';
      }
    });
  }

  if (selectStrategy) {
    selectStrategy.addEventListener('change', async () => {
      const newStrat = selectStrategy.value;
      try {
        await apiRequest('/api/admin/strategy', {
          method: 'POST',
          body: JSON.stringify({ strategy: newStrat })
        });
        loadAllData();
      } catch (err) {
        alert('切换调度策略失败: ' + err.message);
      }
    });
  }

  btnAddAccountModal.addEventListener('click', () => {
    addModal.style.display = 'flex';
  });
  btnCloseModal.addEventListener('click', () => { addModal.style.display = 'none'; });
  btnCancelAdd.addEventListener('click', () => { addModal.style.display = 'none'; });
  btnSubmitAdd.addEventListener('click', handleAddAccount);
}

async function apiRequest(url, options = {}) {
  const headers = options.headers || {};
  headers['X-Admin-Password'] = adminPassword;

  const fetchOptions = { ...options, headers };

  if (fetchOptions.body) {
    headers['Content-Type'] = 'application/json';
  } else if (fetchOptions.method && fetchOptions.method.toUpperCase() === 'POST') {
    headers['Content-Type'] = 'application/json';
    fetchOptions.body = '{}';
  }

  const res = await fetch(url, fetchOptions);
  if (res.status === 401) {
    stopDataPolling();
    loginOverlay.style.display = 'flex';
    loginError.innerText = '密码错误或会话已过期，请重新输入';
    localStorage.removeItem('antigravity_admin_pass');
    throw new Error('Unauthorized');
  }
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || data.message || `HTTP ${res.status}`);
  }
  return data;
}

async function handleLogin() {
  const pass = adminPassInput.value.trim();
  if (!pass) return;

  adminPassword = pass;
  try {
    const data = await apiRequest('/api/admin/stats');
    localStorage.setItem('antigravity_admin_pass', pass);
    loginOverlay.style.display = 'none';
    loginError.innerText = '';
    startDataPolling();
  } catch (err) {
    loginError.innerText = '管理密码不正确，请重试';
    adminPassword = '';
  }
}

function startDataPolling() {
  loadAllData();
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(loadAllData, 4000);
}

function stopDataPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

async function loadAllData() {
  try {
    const [stats, accountsData] = await Promise.all([
      apiRequest('/api/admin/stats'),
      apiRequest('/api/admin/accounts')
    ]);

    const accounts = accountsData.accounts || [];

    // 更新基础指标
    statTotal.innerText = stats.totalAccounts;
    statActive.innerText = stats.activeAccounts;
    statCooldown.innerText = stats.cooldownAccounts;
    statDead.innerText = stats.deadAccounts;
    statConcurrency.innerText = stats.currentTotalConcurrency;
    statRequests.innerText = stats.totalRequestsServed;

    if (selectStrategy && stats.routingStrategy && document.activeElement !== selectStrategy) {
      selectStrategy.value = stats.routingStrategy;
    }

    // 计算全局平均额度 (Claude 5h + Claude 周额度 + Gemini 5h + Gemini 周额度)
    let c5hSum = 0, cWeeklySum = 0, cCount = 0;
    let g5hSum = 0, gWeeklySum = 0, gCount = 0;
    for (const acc of accounts) {
      if (acc.quota) {
        c5hSum += (acc.quota.claude5hFraction ?? 1);
        cWeeklySum += (acc.quota.claudeWeeklyFraction ?? 1);
        cCount++;
        g5hSum += (acc.quota.gemini5hFraction ?? 1);
        gWeeklySum += (acc.quota.geminiWeeklyFraction ?? 1);
        gCount++;
      }
    }
    if (statClaude5h) {
      statClaude5h.innerText = cCount > 0 ? `${(c5hSum / cCount * 100).toFixed(1)}%` : '--%';
    }
    if (statClaudeWeekly) {
      statClaudeWeekly.innerText = cCount > 0 ? `${(cWeeklySum / cCount * 100).toFixed(1)}%` : '--%';
    }
    if (statGemini5h) {
      statGemini5h.innerText = gCount > 0 ? `${(g5hSum / gCount * 100).toFixed(1)}%` : '--%';
    }
    if (statGeminiWeekly) {
      statGeminiWeekly.innerText = gCount > 0 ? `${(gWeeklySum / gCount * 100).toFixed(1)}%` : '--%';
    }

    // 渲染表格
    renderAccounts(accounts);
  } catch (e) {
    // handled in apiRequest
  }
}

function formatResetTime(isoStr) {
  if (!isoStr) return '';
  const diffMs = new Date(isoStr).getTime() - Date.now();
  if (diffMs <= 0) return '即将重置';
  const days = Math.floor(diffMs / (24 * 3600000));
  const hours = Math.floor((diffMs % (24 * 3600000)) / 3600000);
  const mins = Math.floor((diffMs % 3600000) / 60000);
  if (days > 0) return `${days}天${hours}小时后`;
  if (hours > 0) return `${hours}小时${mins}分后`;
  return `${mins}分钟后`;
}

function renderAccounts(accounts) {
  if (accounts.length === 0) {
    accountsTbody.innerHTML = `
      <tr>
        <td colspan="8" class="text-center" style="padding: 30px; color: var(--text-muted);">
          目前账号池中还没有账号，点击右上角 <strong>+ 手动添加</strong> 或 <strong>⚡ 一键同步本机账号</strong> 录入你的第一个 Google 凭据
        </td>
      </tr>`;
    return;
  }

  accountsTbody.innerHTML = accounts.map(acc => {
    let statusBadge = `<span class="badge badge-active">Active</span>`;
    if (acc.status === 'cooldown') {
      const remainingSec = Math.max(0, Math.ceil((acc.cooldownUntil - Date.now()) / 1000));
      statusBadge = `<span class="badge badge-cooldown">Cooldown (${remainingSec}s)</span>`;
    } else if (acc.status === 'dead') {
      statusBadge = `<span class="badge badge-dead">Dead</span>`;
    }

    const proxyHtml = acc.proxyUrl 
      ? `<span class="proxy-tag" title="${acc.proxyUrl}">${acc.proxyUrl.replace(/:\/\/[^@]+@/, '://***@')}</span>`
      : `<span style="color: var(--text-muted); font-size: 11px;">(直接直连)</span>`;

    const tokenStatus = acc.accessTokenExpiresAt > Date.now()
      ? `<span style="color: var(--success);">已获取 (剩 ${Math.floor((acc.accessTokenExpiresAt - Date.now()) / 60000)}m)</span>`
      : `<span style="color: var(--warning);">待换新</span>`;

    // 额度渲染 (5小时额度 + 周期总额度 双向独立直观显示)
    let quotaHtml = '';

    if (acc.validationUrl) {
      quotaHtml = `
        <div style="background: rgba(239, 68, 68, 0.1); border: 1px solid rgba(239, 68, 68, 0.35); border-radius: 8px; padding: 8px 10px; max-width: 260px;">
          <div style="color: #ef4444; font-size: 12px; font-weight: 600; margin-bottom: 3px; display: flex; align-items: center; gap: 4px;">
            ⚠️ <span>需完成 Google 账号验证</span>
          </div>
          <div style="color: var(--text-muted); font-size: 11px; margin-bottom: 6px; line-height: 1.4;">
            新账号首次使用需要前往 Google 确认激活
          </div>
          <div style="display: flex; gap: 6px; align-items: center;">
            <a href="${acc.validationUrl}" target="_blank" rel="noopener noreferrer" class="btn btn-sm" style="background: #ef4444; color: #fff; font-size: 11px; padding: 3px 8px; text-decoration: none; border-radius: 4px; font-weight: 500;">
              👉 点击去验证
            </a>
            <button class="btn btn-outline btn-sm" onclick="checkQuota('${acc.id}')" style="font-size: 10px; padding: 2px 6px;">
              验证后拉取
            </button>
          </div>
        </div>
      `;
    } else if (!acc.quota) {
      quotaHtml = `
        <div style="display: flex; flex-direction: column; gap: 4px;">
          <div style="display: flex; align-items: center; gap: 6px;">
            <span style="color: var(--text-muted); font-size: 11px;">待拉取</span>
            <button class="btn btn-outline btn-sm" onclick="checkQuota('${acc.id}')" style="padding: 2px 6px; font-size: 10px;">拉取</button>
          </div>
          ${acc.lastError ? `<div style="color: var(--danger); font-size: 10px; max-width: 200px;">${escapeHtml(acc.lastError)}</div>` : ''}
        </div>`;
    } else {
      const c5h = (acc.quota.claude5hFraction != null) ? (acc.quota.claude5hFraction * 100).toFixed(1) : '100.0';
      const cW = (acc.quota.claudeWeeklyFraction != null) ? (acc.quota.claudeWeeklyFraction * 100).toFixed(1) : '100.0';
      const g5h = (acc.quota.gemini5hFraction != null) ? (acc.quota.gemini5hFraction * 100).toFixed(1) : '100.0';
      const gW = (acc.quota.geminiWeeklyFraction != null) ? (acc.quota.geminiWeeklyFraction * 100).toFixed(1) : '100.0';

      const c5hNum = parseFloat(c5h);
      const cWNum = parseFloat(cW);
      const g5hNum = parseFloat(g5h);
      const gWNum = parseFloat(gW);

      const c5hUsed = Math.max(0, 100 - c5hNum).toFixed(1);
      const cWUsed = Math.max(0, 100 - cWNum).toFixed(1);
      const g5hUsed = Math.max(0, 100 - g5hNum).toFixed(1);
      const gWUsed = Math.max(0, 100 - gWNum).toFixed(1);

      const c5hColor = c5hNum > 50 ? '#c084fc' : (c5hNum > 15 ? '#fbbf24' : '#f87171');
      const cWColor = cWNum > 50 ? '#a78bfa' : (cWNum > 15 ? '#fbbf24' : '#f87171');
      const g5hColor = g5hNum > 50 ? '#60a5fa' : (g5hNum > 15 ? '#fbbf24' : '#f87171');
      const gWColor = gWNum > 50 ? '#93c5fd' : (gWNum > 15 ? '#fbbf24' : '#f87171');

      const cReset5h = formatResetTime(acc.quota.claudeResetTime);
      const cResetW = formatResetTime(acc.quota.claudeWeeklyResetTime);
      const gReset5h = formatResetTime(acc.quota.geminiResetTime);
      const gResetW = formatResetTime(acc.quota.geminiWeeklyResetTime);

      const c5hDesc = acc.quota.claude5hDesc || '5小时平滑滚动窗口配额';
      const cWDesc = acc.quota.claudeWeeklyDesc || '每周账号可用额度上限';
      const g5hDesc = acc.quota.gemini5hDesc || '5小时平滑滚动窗口配额';
      const gWDesc = acc.quota.geminiWeeklyDesc || '每周账号可用额度上限';

      const c5hWidth = Math.min(100, Math.max(0, c5hNum));
      const cWWidth = Math.min(100, Math.max(0, cWNum));
      const g5hWidth = Math.min(100, Math.max(0, g5hNum));
      const gWWidth = Math.min(100, Math.max(0, gWNum));

      // 满格与恢复倒计时精准区分
      const c5hBadge = (c5hNum < 99.9 && cReset5h)
        ? `<span class="quota-item-time" title="预计回满时间">⏳ ${cReset5h}回满</span>`
        : `<span class="quota-item-time" style="color: #4ade80;">✅ 满格</span>`;

      const cWBadge = (cWNum < 99.9 && cResetW)
        ? `<span class="quota-item-time" title="每周重置时间">🔄 ${cResetW}刷新</span>`
        : `<span class="quota-item-time" style="color: #4ade80;">✅ 满额</span>`;

      const g5hBadge = (g5hNum < 99.9 && gReset5h)
        ? `<span class="quota-item-time" title="预计回满时间">⏳ ${gReset5h}回满</span>`
        : `<span class="quota-item-time" style="color: #4ade80;">✅ 满格</span>`;

      const gWBadge = (gWNum < 99.9 && gResetW)
        ? `<span class="quota-item-time" title="每周重置时间">🔄 ${gResetW}刷新</span>`
        : `<span class="quota-item-time" style="color: #4ade80;">✅ 满额</span>`;

      quotaHtml = `
        <div class="quota-container">
          <!-- 1. Claude / GPT 额度监控 (5小时 + 周期总额度) -->
          <div class="quota-group-card claude-card">
            <div class="quota-group-title">
              <span style="color: #c4b5fd;">Claude / GPT</span>
            </div>

            <!-- 5小时滚动平滑限流 -->
            <div class="quota-item-block" title="${escapeHtml(c5hDesc)}">
              <div class="quota-item-meta">
                <div class="quota-item-title">
                  <span class="quota-type-tag">5小时额度:</span>
                  <span class="quota-rem-val" style="color: ${c5hColor};">${c5h}%</span>
                  <span class="quota-used-tag">(已用 ${c5hUsed}%)</span>
                  ${c5hNum <= 0 ? '<span class="quota-exhausted-tag">已用完</span>' : ''}
                </div>
                ${c5hBadge}
              </div>
              <div class="quota-bar-wrap">
                <div class="quota-bar-fill" style="width: ${c5hWidth}%; background: ${c5hColor};"></div>
              </div>
            </div>

            <!-- 周度总额度 -->
            <div class="quota-item-block" title="${escapeHtml(cWDesc)}">
              <div class="quota-item-meta">
                <div class="quota-item-title">
                  <span class="quota-type-tag">周期总额度:</span>
                  <span class="quota-rem-val" style="color: ${cWColor};">${cW}%</span>
                  <span class="quota-used-tag">(已用 ${cWUsed}%)</span>
                  ${cWNum <= 0 ? '<span class="quota-exhausted-tag">已用完</span>' : ''}
                </div>
                ${cWBadge}
              </div>
              <div class="quota-bar-wrap">
                <div class="quota-bar-fill" style="width: ${cWWidth}%; background: ${cWColor};"></div>
              </div>
            </div>
          </div>

          <!-- 2. Google Gemini 额度监控 (5小时 + 周期总额度) -->
          <div class="quota-group-card gemini-card">
            <div class="quota-group-title">
              <span style="color: #93c5fd;">Google Gemini</span>
            </div>

            <!-- 5小时滚动平滑限流 -->
            <div class="quota-item-block" title="${escapeHtml(g5hDesc)}">
              <div class="quota-item-meta">
                <div class="quota-item-title">
                  <span class="quota-type-tag">5小时额度:</span>
                  <span class="quota-rem-val" style="color: ${g5hColor};">${g5h}%</span>
                  <span class="quota-used-tag">(已用 ${g5hUsed}%)</span>
                  ${g5hNum <= 0 ? '<span class="quota-exhausted-tag">已用完</span>' : ''}
                </div>
                ${g5hBadge}
              </div>
              <div class="quota-bar-wrap">
                <div class="quota-bar-fill" style="width: ${g5hWidth}%; background: ${g5hColor};"></div>
              </div>
            </div>

            <!-- 周度总额度 -->
            <div class="quota-item-block" title="${escapeHtml(gWDesc)}">
              <div class="quota-item-meta">
                <div class="quota-item-title">
                  <span class="quota-type-tag">周期总额度:</span>
                  <span class="quota-rem-val" style="color: ${gWColor};">${gW}%</span>
                  <span class="quota-used-tag">(已用 ${gWUsed}%)</span>
                  ${gWNum <= 0 ? '<span class="quota-exhausted-tag">已用完</span>' : ''}
                </div>
                ${gWBadge}
              </div>
              <div class="quota-bar-wrap">
                <div class="quota-bar-fill" style="width: ${gWWidth}%; background: ${gWColor};"></div>
              </div>
            </div>
          </div>
        </div>
      `;
    }

    return `
      <tr>
        <td>
          <div style="font-weight: 600;">${escapeHtml(acc.email)}</div>
          <div style="font-size: 11px; color: var(--text-muted); font-family: monospace;">${acc.id}</div>
        </td>
        <td>${statusBadge}</td>
        <td>${quotaHtml}</td>
        <td>
          <strong>${acc.activeConcurrency}</strong> / ${acc.maxConcurrency}
        </td>
        <td>${proxyHtml}</td>
        <td>
          <span>${acc.totalRequests}</span>
          ${acc.failedRequests > 0 ? `<span style="color: var(--danger); font-size: 11px;"> (失败: ${acc.failedRequests})</span>` : ''}
        </td>
        <td style="font-size: 12px;">${tokenStatus}</td>
        <td>
          <div class="actions-cell">
            <button class="btn btn-outline btn-sm" onclick="checkQuota('${acc.id}')" title="从 Google 实时拉取最新额度">📊 查额度</button>
            <button class="btn btn-outline btn-sm" onclick="refreshToken('${acc.id}')" title="立即刷新 Token">🔄 刷新</button>
            <button class="btn btn-outline btn-sm" onclick="resetAccount('${acc.id}')" title="重置状态为 Active">⚡ 激活</button>
            <button class="btn btn-danger-outline btn-sm" onclick="deleteAccount('${acc.id}')" title="删除此账号">🗑️</button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

async function handleAddAccount() {
  const email = document.getElementById('input-acc-email').value.trim();
  const token = document.getElementById('input-acc-token').value.trim();
  const proxy = document.getElementById('input-acc-proxy').value.trim();
  const concurrency = parseInt(document.getElementById('input-acc-concurrency').value, 10) || 5;

  if (!email || !token) {
    alert('请填写邮箱和 Refresh Token');
    return;
  }

  try {
    await apiRequest('/api/admin/accounts', {
      method: 'POST',
      body: JSON.stringify({
        email,
        refreshToken: token,
        proxyUrl: proxy || undefined,
        maxConcurrency: concurrency
      })
    });

    addModal.style.display = 'none';
    document.getElementById('input-acc-email').value = '';
    document.getElementById('input-acc-token').value = '';
    document.getElementById('input-acc-proxy').value = '';
    loadAllData();
  } catch (e) {
    alert('添加账号失败: ' + e.message);
  }
}

window.checkQuota = async function(id) {
  try {
    const res = await apiRequest(`/api/admin/accounts/${id}/quota`, { method: 'POST' });
    if (res.success) {
      loadAllData();
    } else {
      alert('获取额度失败，请检查账号状态');
    }
  } catch (e) {
    alert('查询失败: ' + e.message);
  }
};

window.refreshToken = async function(id) {
  try {
    const res = await apiRequest(`/api/admin/accounts/${id}/refresh`, { method: 'POST' });
    if (res.success) {
      loadAllData();
    } else {
      alert('Token 刷新失败，请检查 Refresh Token 是否有效以及网络代理。');
    }
  } catch (e) {
    alert('请求失败: ' + e.message);
  }
};

window.resetAccount = async function(id) {
  try {
    await apiRequest(`/api/admin/accounts/${id}/reset`, { method: 'POST' });
    loadAllData();
  } catch (e) {
    alert('操作失败: ' + e.message);
  }
};

window.deleteAccount = async function(id) {
  if (!confirm('确定要删除该账号凭据吗？')) return;
  try {
    await apiRequest(`/api/admin/accounts/${id}`, { method: 'DELETE' });
    loadAllData();
  } catch (e) {
    alert('删除失败: ' + e.message);
  }
};

function escapeHtml(text) {
  if (!text) return '';
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

document.addEventListener('DOMContentLoaded', init);
