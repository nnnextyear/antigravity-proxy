let adminPassword = localStorage.getItem('antigravity_admin_pass') || '';
let pollTimer = null;
let currentFilter = 'all'; // 'all' | 'active' | 'cooldown' | 'dead'
let searchQuery = '';
let cachedAccounts = [];

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
const btnOauthLogin = document.getElementById('btn-oauth-login');

// 代理配置模态弹窗
const proxyModal = document.getElementById('proxy-modal');
const proxyModalEmail = document.getElementById('proxy-modal-email');
const proxyModalAccId = document.getElementById('proxy-modal-acc-id');
const inputEditProxy = document.getElementById('input-edit-proxy');
const inputEditConcurrency = document.getElementById('input-edit-concurrency');
const btnCloseProxyModal = document.getElementById('btn-close-proxy-modal');
const btnCancelProxy = document.getElementById('btn-cancel-proxy');
const btnSubmitProxy = document.getElementById('btn-submit-proxy');

// 统计指示器
const statTotal = document.getElementById('stat-total');
const statActive = document.getElementById('stat-active');
const statCooldown = document.getElementById('stat-cooldown');
const statDead = document.getElementById('stat-dead');
const statConcurrency = document.getElementById('stat-concurrency');
const statRequests = document.getElementById('stat-requests');
const statTokens = document.getElementById('stat-tokens');
const statTokensTotal = document.getElementById('stat-tokens-total');
const statTokensInput = document.getElementById('stat-tokens-input');
const statTokensOutput = document.getElementById('stat-tokens-output');
const statTokensCacheRead = document.getElementById('stat-tokens-cache-read');
const statTokensCacheWrite = document.getElementById('stat-tokens-cache-write');
const statTokensCacheHit = document.getElementById('stat-tokens-cache-hit');
const statClaude5h = document.getElementById('stat-claude-5h');
const statClaudeWeekly = document.getElementById('stat-claude-weekly');
const statClaudeWeeklyBar = document.getElementById('stat-claude-weekly-bar');
const statClaudeWeeklyRefresh = document.getElementById('stat-claude-weekly-refresh');
const statClaudeWaveFill = document.getElementById('stat-claude-wave-fill');
const statClaudeHealth = document.getElementById('stat-claude-health');
const statClaudeAvail = document.getElementById('stat-claude-avail');
const statClaudeReset = document.getElementById('stat-claude-reset');

const statGemini5h = document.getElementById('stat-gemini-5h');
const statGeminiWeekly = document.getElementById('stat-gemini-weekly');
const statGeminiWeeklyBar = document.getElementById('stat-gemini-weekly-bar');
const statGeminiWeeklyRefresh = document.getElementById('stat-gemini-weekly-refresh');
const statGeminiWaveFill = document.getElementById('stat-gemini-wave-fill');
const statGeminiHealth = document.getElementById('stat-gemini-health');
const statGeminiAvail = document.getElementById('stat-gemini-avail');
const statGeminiReset = document.getElementById('stat-gemini-reset');

// 调度策略自定义组件
const strategyDropdown = document.getElementById('strategy-dropdown');
const strategyTrigger = document.getElementById('strategy-trigger');
const strategyActiveName = document.getElementById('strategy-active-name');
const strategyPopover = document.getElementById('strategy-popover');

// 账号卡片容器
const cardsContainer = document.getElementById('accounts-cards-view');

function initStrategyDropdown() {
  if (!strategyDropdown || !strategyTrigger || !strategyPopover) return;

  strategyTrigger.addEventListener('click', (e) => {
    e.stopPropagation();
    strategyDropdown.classList.toggle('open');
  });

  document.addEventListener('click', (e) => {
    if (!strategyDropdown.contains(e.target)) {
      strategyDropdown.classList.remove('open');
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') strategyDropdown.classList.remove('open');
  });

  const options = strategyPopover.querySelectorAll('.popover-option');
  options.forEach(opt => {
    opt.addEventListener('click', async () => {
      const strategy = opt.getAttribute('data-strategy');
      if (!strategy) return;

      options.forEach(o => o.classList.remove('active'));
      opt.classList.add('active');

      const nameEl = opt.querySelector('.opt-name');
      if (nameEl && strategyActiveName) {
        strategyActiveName.innerText = nameEl.innerText;
      }

      strategyDropdown.classList.remove('open');

      try {
        const res = await apiRequest('/api/admin/strategy', {
          method: 'POST',
          body: JSON.stringify({ strategy })
        });
        showToast(res.message || `已切换为: ${nameEl.innerText}`, 'success');
      } catch (err) {
        showToast(`切换策略失败: ${err.message}`, 'error');
      }
    });
  });
}

function syncStrategyDropdown(strategy) {
  if (!strategyPopover || !strategyActiveName) return;
  const options = strategyPopover.querySelectorAll('.popover-option');
  options.forEach(opt => {
    const s = opt.getAttribute('data-strategy');
    if (s === strategy) {
      options.forEach(o => o.classList.remove('active'));
      opt.classList.add('active');
      const nameEl = opt.querySelector('.opt-name');
      if (nameEl) strategyActiveName.innerText = nameEl.innerText;
    }
  });
}

function init() {
  if (adminPassword) {
    loginOverlay.style.display = 'none';
    startDataPolling();
  } else {
    loginOverlay.style.display = 'flex';
  }

  // 初始化自定义调度策略下拉框
  initStrategyDropdown();

  // 绑定基础事件
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
    btnRefreshData.disabled = true;
    loadAllData().finally(() => {
      setTimeout(() => { btnRefreshData.disabled = false; }, 300);
    });
  });

  // 复制 API Base URL
  const apiBadge = document.getElementById('api-endpoint-badge');
  if (apiBadge) {
    apiBadge.addEventListener('click', () => {
      const fullUrl = `${window.location.origin}/v1`;
      navigator.clipboard.writeText(fullUrl).then(() => {
        showToast(`已复制 Base URL: ${fullUrl}`, 'success');
      }).catch(() => {
        prompt('请复制 API 地址:', fullUrl);
      });
    });
  }

  // 复制 API Key
  const apiKeyBadge = document.getElementById('api-key-badge');
  if (apiKeyBadge) {
    apiKeyBadge.addEventListener('click', () => {
      const codeEl = document.getElementById('api-key-text');
      const key = codeEl ? codeEl.innerText.trim() : 'sk-antigravity';
      navigator.clipboard.writeText(key).then(() => {
        showToast(`已复制 API Key: ${key}`, 'success');
      });
    });
  }

  // 同步本机
  const btnSyncLocal = document.getElementById('btn-sync-local');
  if (btnSyncLocal) {
    btnSyncLocal.addEventListener('click', async () => {
      btnSyncLocal.disabled = true;
      const origHtml = btnSyncLocal.innerHTML;
      btnSyncLocal.innerText = '正在读取...';
      try {
        const res = await apiRequest('/api/admin/sync-local', { method: 'POST' });
        showToast(res.message + ': ' + (res.account?.email || ''), 'success');
        loadAllData();
      } catch (e) {
        showToast('同步失败: ' + e.message, 'error');
      } finally {
        btnSyncLocal.disabled = false;
        btnSyncLocal.innerHTML = origHtml;
      }
    });
  }

  // 刷新全池额度
  const btnSyncAllQuota = document.getElementById('btn-sync-all-quota');
  if (btnSyncAllQuota) {
    btnSyncAllQuota.addEventListener('click', async () => {
      btnSyncAllQuota.disabled = true;
      const origHtml = btnSyncAllQuota.innerHTML;
      btnSyncAllQuota.innerText = '正在刷新...';
      try {
        await apiRequest('/api/admin/sync-all-quota', { method: 'POST' });
        showToast('全池账号真实配额已更新', 'success');
        loadAllData();
      } catch (e) {
        showToast('刷新额度失败: ' + e.message, 'error');
      } finally {
        btnSyncAllQuota.disabled = false;
        btnSyncAllQuota.innerHTML = origHtml;
      }
    });
  }

  // 搜索监听
  const searchInput = document.getElementById('account-search-input');
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      searchQuery = e.target.value.trim().toLowerCase();
      renderFilteredAccounts();
    });
  }

  // 过滤 Tab 监听
  const filterTabs = document.querySelectorAll('.filter-tab');
  filterTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      filterTabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      currentFilter = tab.getAttribute('data-filter') || 'all';
      renderFilteredAccounts();
    });
  });

  // Modal 监听: 添加账号
  if (btnAddAccountModal) btnAddAccountModal.addEventListener('click', openAddModal);
  if (btnCloseModal) btnCloseModal.addEventListener('click', closeAddModal);
  if (btnCancelAdd) btnCancelAdd.addEventListener('click', closeAddModal);
  if (btnSubmitAdd) btnSubmitAdd.addEventListener('click', handleAddAccount);
  if (btnOauthLogin) btnOauthLogin.addEventListener('click', startOauthLogin);

  if (addModal) {
    addModal.addEventListener('click', (e) => {
      if (e.target === addModal) closeAddModal();
    });
  }

  // Modal 监听: 出口代理配置
  if (btnCloseProxyModal) btnCloseProxyModal.addEventListener('click', closeProxyModal);
  if (btnCancelProxy) btnCancelProxy.addEventListener('click', closeProxyModal);
  if (btnSubmitProxy) btnSubmitProxy.addEventListener('click', handleSaveProxyConfig);

  if (proxyModal) {
    proxyModal.addEventListener('click', (e) => {
      if (e.target === proxyModal) closeProxyModal();
    });
  }

  // 监听代理输入框手动输入，自动联动预设的高亮状态
  if (inputEditProxy) {
    inputEditProxy.addEventListener('input', (e) => {
      updateProxyPresetChipsActive(e.target.value.trim());
    });
  }

  // ESC 键关闭所有弹窗
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeAddModal();
      closeProxyModal();
      if (strategyDropdown) strategyDropdown.classList.remove('open');
    }
  });
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
    loginError.innerText = '密码错误或会话已失效，请重新输入';
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

    cachedAccounts = accountsData.accounts || [];

    // 更新大盘基础指标
    if (statTotal) statTotal.innerText = stats.totalAccounts;
    if (statActive) statActive.innerText = stats.activeAccounts;
    if (statCooldown) statCooldown.innerText = stats.cooldownAccounts;
    if (statDead) statDead.innerText = stats.deadAccounts;
    if (statConcurrency) statConcurrency.innerText = stats.currentTotalConcurrency;
    if (statRequests) statRequests.innerText = stats.totalRequestsServed;
    if (statTokens) {
      if (stats.hasTokenUsage) {
        statTokens.innerText = formatTokenCount(stats.totalTokens);
      } else {
        statTokens.innerText = '--';
      }
    }
    if (statTokensTotal) statTokensTotal.innerText = stats.hasTokenUsage ? formatTokenCount(stats.totalTokens) : '--';
    if (statTokensInput) statTokensInput.innerText = stats.hasTokenUsage ? formatTokenCount(stats.totalPromptTokens) : '--';
    if (statTokensOutput) statTokensOutput.innerText = stats.hasTokenUsage ? formatTokenCount(stats.totalCompletionTokens) : '--';
    const cacheReadTokens = Number(stats.totalCacheReadTokens ?? stats.totalCachedTokens);
    const promptTokens = Number(stats.totalPromptTokens);
    const cacheHitRate = stats.hasTokenUsage && promptTokens > 0 && Number.isFinite(cacheReadTokens)
      ? `${Math.min(100, Math.max(0, cacheReadTokens / promptTokens * 100)).toFixed(1)}%`
      : '--';
    if (statTokensCacheRead) statTokensCacheRead.innerText = stats.hasTokenUsage ? formatTokenCount(cacheReadTokens) : '--';
    if (statTokensCacheWrite) statTokensCacheWrite.innerText = stats.hasTokenUsage ? formatTokenCount(stats.totalCacheCreationTokens) : '--';
    if (statTokensCacheHit) statTokensCacheHit.innerText = cacheHitRate;

    const badgeTextEl = document.getElementById('stat-active-badge-text');
    if (badgeTextEl) badgeTextEl.innerText = `${stats.activeAccounts} 活跃`;

    if (stats && stats.routingStrategy) {
      syncStrategyDropdown(stats.routingStrategy);
    }

    // 计算各分类计数
    let deadCount = 0, cooldownCount = 0, activeCount = 0;
    for (const acc of cachedAccounts) {
      if (acc.status === 'dead') deadCount++;
      else if (acc.status === 'cooldown') cooldownCount++;
      else if (acc.status === 'active') activeCount++;
    }
    const cAll = document.getElementById('count-all');
    const cActive = document.getElementById('count-active');
    const cCooldown = document.getElementById('count-cooldown');
    const cDead = document.getElementById('count-dead');
    if (cAll) cAll.innerText = cachedAccounts.length;
    if (cActive) cActive.innerText = activeCount;
    if (cCooldown) cCooldown.innerText = cooldownCount;
    if (cDead) cDead.innerText = deadCount;

    // 计算全局可用率与平均额度
    let c5hSum = 0, cWeeklySum = 0, cCount = 0, cActiveAvail = 0;
    let g5hSum = 0, gWeeklySum = 0, gCount = 0, gActiveAvail = 0;

    for (const acc of cachedAccounts) {
      if (acc.status !== 'disabled' && acc.quota) {
        const c5h = (acc.quota.claude5hFraction ?? 1);
        c5hSum += c5h;
        cWeeklySum += (acc.quota.claudeWeeklyFraction ?? 1);
        cCount++;
        if (acc.status === 'active' && c5h > 0.05) cActiveAvail++;

        const g5h = (acc.quota.gemini5hFraction ?? 1);
        g5hSum += g5h;
        gWeeklySum += (acc.quota.geminiWeeklyFraction ?? 1);
        gCount++;
        if (acc.status === 'active' && g5h > 0.05) gActiveAvail++;
      }
    }

    const cAvg = cCount > 0 ? (c5hSum / cCount * 100) : 0;
    const gAvg = gCount > 0 ? (g5hSum / gCount * 100) : 0;
    const cWAvg = cCount > 0 ? (cWeeklySum / cCount * 100) : 0;
    const gWAvg = gCount > 0 ? (gWeeklySum / gCount * 100) : 0;

    // Claude 监控卡 (左侧水仓显示 5h 水位，右侧显示 7d 周度额度与最快刷新，底栏展示 5h 最快回满)
    if (statClaude5h) statClaude5h.innerText = cCount > 0 ? `${cAvg.toFixed(1)}%` : '--%';
    if (statClaudeWaveFill) statClaudeWaveFill.style.height = `${Math.min(100, Math.max(0, cAvg))}%`;
    if (statClaudeWeekly) statClaudeWeekly.innerText = cCount > 0 ? `${cWAvg.toFixed(1)}%` : '--%';
    if (statClaudeWeeklyBar) statClaudeWeeklyBar.style.width = `${Math.min(100, Math.max(0, cWAvg))}%`;
    if (statClaudeWeeklyRefresh) {
      statClaudeWeeklyRefresh.innerText = getPoolFastestWeeklyRefreshText(cachedAccounts, 'claude');
      statClaudeWeeklyRefresh.title = '全池 7 天额度最快刷新时间（各账号详细信息可在下方矩阵查看）';
    }
    if (statClaudeAvail) statClaudeAvail.innerText = cCount > 0 ? `${cActiveAvail}/${cachedAccounts.length} 就绪` : '--';
    if (statClaudeReset) {
      const cResetText = getPoolFastest5hRecoveryText(cachedAccounts, 'claude');
      statClaudeReset.innerText = cResetText;
      statClaudeReset.className = cResetText.includes('全部满格') ? 'pool-reset-hint full' : 'pool-reset-hint';
      statClaudeReset.title = '全池 5 小时额度最快回满时间（各账号详细信息可在下方矩阵查看）';
    }

    // Gemini 监控卡 (左侧水仓显示 5h 水位，右侧显示 7d 周度额度与最快刷新，底栏展示 5h 最快回满)
    if (statGemini5h) statGemini5h.innerText = gCount > 0 ? `${gAvg.toFixed(1)}%` : '--%';
    if (statGeminiWaveFill) statGeminiWaveFill.style.height = `${Math.min(100, Math.max(0, gAvg))}%`;
    if (statGeminiWeekly) statGeminiWeekly.innerText = gCount > 0 ? `${gWAvg.toFixed(1)}%` : '--%';
    if (statGeminiWeeklyBar) statGeminiWeeklyBar.style.width = `${Math.min(100, Math.max(0, gWAvg))}%`;
    if (statGeminiWeeklyRefresh) {
      statGeminiWeeklyRefresh.innerText = getPoolFastestWeeklyRefreshText(cachedAccounts, 'gemini');
      statGeminiWeeklyRefresh.title = '全池 7 天额度最快刷新时间（各账号详细信息可在下方矩阵查看）';
    }
    if (statGeminiAvail) statGeminiAvail.innerText = gCount > 0 ? `${gActiveAvail}/${cachedAccounts.length} 就绪` : '--';
    if (statGeminiReset) {
      const gResetText = getPoolFastest5hRecoveryText(cachedAccounts, 'gemini');
      statGeminiReset.innerText = gResetText;
      statGeminiReset.className = gResetText.includes('全部满格') ? 'pool-reset-hint full' : 'pool-reset-hint';
      statGeminiReset.title = '全池 5 小时额度最快回满时间（各账号详细信息可在下方矩阵查看）';
    }

    const getHealthState = (pct) => {
      if (pct <= 0) return { text: '● 水位枯竭', cls: 'water-health-dead' };
      if (pct < 25) return { text: '● 水位紧张', cls: 'water-health-warn' };
      if (pct < 60) return { text: '● 水位适中', cls: 'water-health-mid' };
      return { text: '● 水位充沛', cls: 'water-health-good' };
    };

    if (statClaudeHealth) {
      const h = getHealthState(cAvg);
      statClaudeHealth.innerText = h.text;
      statClaudeHealth.className = `water-health-tag ${h.cls}`;
    }
    if (statGeminiHealth) {
      const h = getHealthState(gAvg);
      statGeminiHealth.innerText = h.text;
      statGeminiHealth.className = `water-health-tag ${h.cls}`;
    }

    renderFilteredAccounts();
  } catch (e) {
    // handled in apiRequest
  }
}

function renderFilteredAccounts() {
  const filtered = cachedAccounts.filter(acc => {
    // 状态过滤
    if (currentFilter === 'active' && acc.status !== 'active') return false;
    if (currentFilter === 'cooldown' && acc.status !== 'cooldown') return false;
    if (currentFilter === 'dead' && acc.status !== 'dead') return false;

    // 搜索过滤
    if (searchQuery) {
      const email = (acc.email || '').toLowerCase();
      const id = (acc.id || '').toLowerCase();
      if (!email.includes(searchQuery) && !id.includes(searchQuery)) return false;
    }
    return true;
  });

  renderCardsView(filtered);
}

function formatTokenCount(value) {
  const count = Number(value);
  if (!Number.isFinite(count)) return '--';
  if (count >= 1000000) return `${(count / 1000000).toFixed(2)}M`;
  if (count >= 1000) return `${(count / 1000).toFixed(1)}k`;
  return String(Math.round(count));
}

function getAvatarColor(email) {
  const gradients = [
    'linear-gradient(135deg, #4f46e5, #7c3aed)',
    'linear-gradient(135deg, #0284c7, #06b6d4)',
    'linear-gradient(135deg, #059669, #10b981)',
    'linear-gradient(135deg, #d97706, #f59e0b)',
    'linear-gradient(135deg, #e11d48, #f43f5e)'
  ];
  let h = 0;
  for (let i = 0; i < (email || '').length; i++) h = (h * 31 + email.charCodeAt(i)) >>> 0;
  return gradients[h % gradients.length];
}

function formatResetTime(isoStr) {
  if (!isoStr) return '';
  const diffMs = new Date(isoStr).getTime() - Date.now();
  if (diffMs <= 0) return '即将重置';
  const days = Math.floor(diffMs / (24 * 3600000));
  const hours = Math.floor((diffMs % (24 * 3600000)) / 3600000);
  const mins = Math.floor((diffMs % 3600000) / 60000);
  if (days > 0) return `${days}天${hours}h后`;
  if (hours > 0) return `${hours}h${mins}m后`;
  return `${mins}m后`;
}

function getShortEmailPrefix(email) {
  if (!email) return 'Acc';
  const prefix = email.split('@')[0];
  if (prefix.length <= 6) return prefix;
  return prefix.slice(0, 6);
}

function formatDurationCompact(diffMs) {
  if (diffMs <= 0) return '即将回满';
  const hours = Math.floor(diffMs / 3600000);
  const mins = Math.floor((diffMs % 3600000) / 60000);
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    const remH = hours % 24;
    return `${days}d${remH}h`;
  }
  if (hours > 0) return `${hours}h${mins}m`;
  return `${mins}m`;
}

window.scrollToAccount = function(accId) {
  if (!accId) return;
  const card = document.getElementById(`card-${accId}`);
  if (!card) return;
  card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  card.classList.remove('card-highlight-pulse');
  void card.offsetWidth;
  card.classList.add('card-highlight-pulse');
  setTimeout(() => {
    card.classList.remove('card-highlight-pulse');
  }, 2200);
};

// 获取全池某模型家族 5 小时额度最快回满时间文本 (纯时间，不包含任何账号名称)
function getPoolFastest5hRecoveryText(accounts, family) {
  if (!accounts || accounts.length === 0) return '暂无账号';

  const isClaude = family === 'claude';
  let minDiffMs = Infinity;
  let allFull = true;
  let hasValidQuota = false;
  const now = Date.now();

  for (const acc of accounts) {
    if (!acc.quota) continue;
    hasValidQuota = true;
    const fraction = isClaude ? (acc.quota.claude5hFraction ?? 1) : (acc.quota.gemini5hFraction ?? 1);
    const resetIso = isClaude ? acc.quota.claudeResetTime : acc.quota.geminiResetTime;

    if (fraction < 0.99) {
      allFull = false;
      if (resetIso) {
        const diff = new Date(resetIso).getTime() - now;
        if (diff > 0 && diff < minDiffMs) {
          minDiffMs = diff;
        }
      }
    }
  }

  if (!hasValidQuota) return '⏳ 周期中';
  if (allFull) return '✅ 5h已全部满格';
  if (minDiffMs === Infinity) return '⏳ 5h即将回满';

  const hours = Math.floor(minDiffMs / 3600000);
  const mins = Math.floor((minDiffMs % 3600000) / 60000);

  if (hours > 0) {
    return mins > 0 ? `⏳ 5h最快 ${hours}h${mins}m后回满` : `⏳ 5h最快 ${hours}h后回满`;
  }
  if (mins > 0) {
    return `⏳ 5h最快 ${mins}m后回满`;
  }
  return '⏳ 5h即将回满';
}

// 获取全池某模型家族 7 天周度额度最快刷新时间文本 (纯天数/小时，不包含任何账号名称)
function getPoolFastestWeeklyRefreshText(accounts, family) {
  if (!accounts || accounts.length === 0) return '--';

  const isClaude = family === 'claude';
  let minDiffMs = Infinity;
  let hasValidReset = false;
  const now = Date.now();

  for (const acc of accounts) {
    if (!acc.quota) continue;
    const weeklyIso = isClaude ? acc.quota.claudeWeeklyResetTime : acc.quota.geminiWeeklyResetTime;
    if (weeklyIso) {
      hasValidReset = true;
      const diff = new Date(weeklyIso).getTime() - now;
      if (diff > 0 && diff < minDiffMs) {
        minDiffMs = diff;
      }
    }
  }

  if (!hasValidReset || minDiffMs === Infinity) return '🔄 周期中';

  const days = Math.floor(minDiffMs / (24 * 3600000));
  const hours = Math.floor((minDiffMs % (24 * 3600000)) / 3600000);
  const mins = Math.floor((minDiffMs % 3600000) / 60000);

  if (days > 0) {
    return `最快 ${days}天后刷新`;
  }
  if (hours > 0) {
    return `最快 ${hours}h后刷新`;
  }
  if (mins > 0) {
    return `最快 ${mins}m后刷新`;
  }
  return '今日刷新';
}

function getStatusPill(acc) {
  const isClaudeExhausted = acc.quota && acc.quota.claude5hFraction <= 0.01;
  const isGeminiExhausted = acc.quota && acc.quota.gemini5hFraction <= 0.01;

  if (acc.status === 'disabled') {
    return `<span class="status-badge-pill status-badge-disabled">已停用</span>`;
  } else if (acc.status === 'cooldown') {
    const remainingSec = Math.max(0, Math.ceil((acc.cooldownUntil - Date.now()) / 1000));
    return `<span class="status-badge-pill status-badge-cooldown"><span class="pulse-dot amber"></span>冷却 (${remainingSec}s)</span>`;
  } else if (acc.status === 'dead') {
    return `<span class="status-badge-pill status-badge-dead">异常失效</span>`;
  } else if (isClaudeExhausted && !isGeminiExhausted) {
    return `<span class="status-badge-pill status-badge-gemini" title="Claude 暂尽，Gemini 依然充足">Gemini可用</span>`;
  } else if (!isClaudeExhausted && isGeminiExhausted) {
    return `<span class="status-badge-pill status-badge-claude" title="Gemini 暂尽，Claude 依然充足">Claude可用</span>`;
  } else if (isClaudeExhausted && isGeminiExhausted) {
    return `<span class="status-badge-pill status-badge-dead">双额度暂尽</span>`;
  }
  return `<span class="status-badge-pill status-badge-active"><span class="pulse-dot green"></span>正常可用</span>`;
}

function getMetaClusterHtml(acc) {
  const proxyText = acc.proxyUrl 
    ? acc.proxyUrl.replace(/:\/\/[^@]+@/, '://***@')
    : '直连出口';
  const isCustomProxy = Boolean(acc.proxyUrl);

  const tokenTimeLeft = acc.accessTokenExpiresAt > Date.now()
    ? `${Math.floor((acc.accessTokenExpiresAt - Date.now()) / 60000)}m`
    : '待换新';

  return `
    <span class="meta-pill" title="活跃并发 / 最大允许限制">
      <span>并发:</span> <strong>${acc.activeConcurrency}/${acc.maxConcurrency}</strong>
    </span>
    <button type="button" class="meta-pill meta-pill-proxy" onclick="openProxyModal('${acc.id}')" title="点击快速修改该账号专属出口代理">
      <span>出口:</span> <strong class="${isCustomProxy ? 'text-cyan' : ''}">${escapeHtml(proxyText)}</strong>
      <svg class="pill-edit-icon" width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
    </button>
    <span class="meta-pill" title="累计请求数">
      <span>请求:</span> <strong>${acc.totalRequests}</strong>${acc.failedRequests > 0 ? `<span class="meta-err">(${acc.failedRequests}失败)</span>` : ''}
    </span>
    <span class="meta-pill" title="Token 剩余有效期">
      <span>Token:</span> <strong>${tokenTimeLeft}</strong>
    </span>
  `;
}

function getCardHtml(acc) {
  const initial = (acc.email || 'A')[0].toUpperCase();
  const avatarGrad = getAvatarColor(acc.email);
  const statusPill = getStatusPill(acc);
  const claudePod = renderPodHtml('claude', acc);
  const geminiPod = renderPodHtml('gemini', acc);
  const metaHtml = getMetaClusterHtml(acc);
  const isDisabled = acc.status === 'disabled';

  return `
    <div class="account-card" id="card-${acc.id}" data-id="${acc.id}">
      <!-- 头部: 账号身份与状态 -->
      <div class="card-header-row">
        <div class="acc-identity">
          <div class="avatar-circle" style="background: ${avatarGrad};">${initial}</div>
          <div class="acc-text-meta">
            <div class="acc-email-title" title="${escapeHtml(acc.email)}">${escapeHtml(acc.email)}</div>
            <div class="acc-id-chip" title="点击复制 ID" onclick="copyText('${acc.id}', '账号 ID')">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
              <span>${acc.id}</span>
            </div>
          </div>
        </div>
        <div class="acc-status-wrap">${statusPill}</div>
      </div>

      <!-- 中段: 双配额微舱 -->
      <div class="card-quota-compartment">
        ${claudePod}
        ${geminiPod}
      </div>

      <!-- 底栏: 关键指标与操作 -->
      <div class="card-bottom-bar">
        <div class="meta-stats-cluster">
          ${metaHtml}
        </div>

        <div class="card-actions-toolbar">
          <button class="card-action-btn action-quota" onclick="checkQuota('${acc.id}', this)" title="从 Google 实时拉取最新配额">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 20V10M12 20V4M6 20v-6"/></svg>
            <span>查额度</span>
          </button>
          <button class="card-action-btn action-proxy" onclick="openProxyModal('${acc.id}')" title="配置该账号独立出口代理与并发">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
            <span>代理</span>
          </button>
          <button class="card-action-btn action-refresh" onclick="refreshToken('${acc.id}', this)" title="立即换新 Access Token">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
            <span>刷新</span>
          </button>
          ${isDisabled ? '' : `
            <button class="card-action-btn action-activate" onclick="resetAccount('${acc.id}', this)" title="解除冷却重置为活跃状态">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
              <span>激活</span>
            </button>
          `}
          <button class="card-action-btn action-disable" onclick="toggleAccountDisabled('${acc.id}', ${isDisabled}, this)" title="${isDisabled ? '重新启用此账号并恢复调度' : '停用此账号，保留凭据和历史数据'}">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M8 12h8"/></svg>
            <span>${isDisabled ? '启用' : '停用'}</span>
          </button>
          <button class="card-action-btn action-delete" onclick="deleteAccount('${acc.id}', this)" title="删除此账号">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          </button>
        </div>
      </div>
    </div>
  `;
}

function updateCardInPlace(acc) {
  const card = document.getElementById(`card-${acc.id}`);
  if (!card) return;

  // 1. 更新状态 Pill
  const statusWrap = card.querySelector('.acc-status-wrap');
  const newStatus = getStatusPill(acc);
  if (statusWrap && statusWrap.innerHTML !== newStatus) {
    statusWrap.innerHTML = newStatus;
  }

  // 2. 更新配额双舱 (仅当内容变动时更新，让 CSS 平滑过渡)
  const compartment = card.querySelector('.card-quota-compartment');
  const newPodsHtml = renderPodHtml('claude', acc) + renderPodHtml('gemini', acc);
  if (compartment && compartment.innerHTML !== newPodsHtml) {
    compartment.innerHTML = newPodsHtml;
  }

  // 3. 更新底栏指标
  const metaCluster = card.querySelector('.meta-stats-cluster');
  const newMetaHtml = getMetaClusterHtml(acc);
  if (metaCluster && metaCluster.innerHTML !== newMetaHtml) {
    metaCluster.innerHTML = newMetaHtml;
  }
}

// 渲染卡片矩阵视图 (带防闪烁差量比对机制)
function renderCardsView(accounts) {
  if (accounts.length === 0) {
    cardsContainer.innerHTML = `
      <div class="empty-placeholder">
        <p style="font-size: 14px; font-weight: 500; margin-bottom: 6px; color: #cbd5e1;">未匹配到任何账号</p>
        <span style="font-size: 12px; color: var(--text-muted);">可尝试清空搜索条件，或点击右上角 <strong>+ 添加账号</strong></span>
      </div>`;
    return;
  }

  const existingCards = cardsContainer.querySelectorAll('.account-card');
  const existingIds = Array.from(existingCards).map(c => c.getAttribute('data-id') || c.id.replace('card-', ''));
  const newIds = accounts.map(a => a.id);

  const isSameOrder = existingIds.length === newIds.length && existingIds.every((id, i) => id === newIds[i]);

  if (!isSameOrder) {
    cardsContainer.innerHTML = accounts.map(acc => getCardHtml(acc)).join('');
    return;
  }

  // 账号集合完全相同时：原位就地更新 DOM 属性，杜绝整页闪烁！
  for (const acc of accounts) {
    updateCardInPlace(acc);
  }
}

function renderPodHtml(family, acc) {
  const isClaude = family === 'claude';
  const quota = acc.quota;

  if (acc.validationUrl) {
    return `
      <div class="quota-pod ${isClaude ? 'pod-claude' : 'pod-gemini'} pod-alert">
        <div class="pod-head">
          <div class="pod-title-wrap">
            <span class="pod-brand-dot ${isClaude ? 'dot-purple' : 'dot-cyan'}"></span>
            <span class="pod-title">${isClaude ? 'Claude / GPT' : 'Google Gemini'}</span>
          </div>
          <span class="badge-alert-tag">需授权</span>
        </div>
        <div class="pod-alert-body">
          <a href="${acc.validationUrl}" target="_blank" rel="noopener noreferrer" class="card-action-btn card-action-compact action-authorize">前往授权</a>
          <button type="button" class="card-action-btn card-action-compact action-quota" onclick="checkQuota('${acc.id}', this)">拉取额度</button>
        </div>
      </div>
    `;
  }

  if (!quota) {
    return `
      <div class="quota-pod ${isClaude ? 'pod-claude' : 'pod-gemini'}">
        <div class="pod-head">
          <div class="pod-title-wrap">
            <span class="pod-brand-dot ${isClaude ? 'dot-purple' : 'dot-cyan'}"></span>
            <span class="pod-title">${isClaude ? 'Claude / GPT' : 'Google Gemini'}</span>
          </div>
          <span class="pod-time-tag">未检测</span>
        </div>
        <div class="pod-empty-body">
          <span>尚未拉取配额</span>
          <button type="button" class="card-action-btn card-action-compact action-quota" onclick="checkQuota('${acc.id}', this)">拉取额度</button>
        </div>
      </div>
    `;
  }

  const f5h = isClaude ? quota.claude5hFraction : quota.gemini5hFraction;
  const fW = isClaude ? quota.claudeWeeklyFraction : quota.geminiWeeklyFraction;
  const r5h = isClaude ? quota.claudeResetTime : quota.geminiResetTime;
  const rW = isClaude ? quota.claudeWeeklyResetTime : quota.geminiWeeklyResetTime;

  const p5h = (f5h * 100).toFixed(1);
  const pW = (fW * 100).toFixed(1);
  const p5hNum = parseFloat(p5h);
  const pWNum = parseFloat(pW);

  // 颜色根据剩余额度动态变化
  const getTheme = (pct, isWeekly) => {
    if (pct <= 0) return { fill: 'linear-gradient(90deg, #ef4444, #f87171)', text: '#f87171' };
    if (pct < 20) return { fill: 'linear-gradient(90deg, #ea580c, #fb923c)', text: '#fb923c' };
    if (pct < 40) return { fill: 'linear-gradient(90deg, #d97706, #fbbf24)', text: '#fbbf24' };
    if (isClaude) {
      return isWeekly
        ? { fill: 'linear-gradient(90deg, #7c3aed, #a855f7)', text: '#d8b4fe' }
        : { fill: 'linear-gradient(90deg, #9333ea, #c084fc)', text: '#c084fc' };
    } else {
      return isWeekly
        ? { fill: 'linear-gradient(90deg, #0369a1, #0ea5e9)', text: '#7dd3fc' }
        : { fill: 'linear-gradient(90deg, #0284c7, #38bdf8)', text: '#38bdf8' };
    }
  };

  const c5hTheme = getTheme(p5hNum, false);
  const cWTheme = getTheme(pWNum, true);

  const time5h = formatResetTime(r5h);
  const timeW = formatResetTime(rW);

  const time5hTag = (p5hNum < 99.9 && time5h)
    ? `<span class="pod-time-tag">⏳ ${time5h}</span>`
    : `<span class="pod-time-tag full">✅ 满格</span>`;

  const timeWTag = timeW
    ? `<span class="pod-time-tag">🔄 ${timeW}</span>`
    : `<span class="pod-time-tag">🔄 周期中</span>`;

  return `
    <div class="quota-pod ${isClaude ? 'pod-claude' : 'pod-gemini'}">
      <div class="pod-head">
        <div class="pod-title-wrap">
          <span class="pod-brand-dot ${isClaude ? 'dot-purple' : 'dot-cyan'}"></span>
          <span class="pod-title">${isClaude ? 'Claude / GPT' : 'Google Gemini'}</span>
        </div>
      </div>

      <!-- 第一条线: 5h 水位 -->
      <div class="pod-track">
        <div class="pod-track-meta">
          <div class="pod-track-label-group">
            <span class="pod-track-label">5h 水位</span>
            ${time5hTag}
          </div>
          <span class="pod-track-num" style="color: ${c5hTheme.text};">${p5h}%</span>
        </div>
        <div class="pod-bar-wrap">
          <div class="pod-bar-fill" style="width: ${Math.min(100, Math.max(0, p5hNum))}%; background: ${c5hTheme.fill};"></div>
        </div>
      </div>

      <!-- 第二条线: 7d 周期总额度 -->
      <div class="pod-track">
        <div class="pod-track-meta">
          <div class="pod-track-label-group">
            <span class="pod-track-label">7d 周度</span>
            ${timeWTag}
          </div>
          <span class="pod-track-num" style="color: ${cWTheme.text};">${pW}%</span>
        </div>
        <div class="pod-bar-wrap">
          <div class="pod-bar-fill" style="width: ${Math.min(100, Math.max(0, pWNum))}%; background: ${cWTheme.fill};"></div>
        </div>
      </div>
    </div>
  `;
}

function formatCreatedTime(ts) {
  if (!ts) return '';
  const date = new Date(ts);
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

window.openAddModal = function() {
  const modal = document.getElementById('add-modal');
  if (modal) {
    modal.style.display = 'flex';
    setConcurrency('input-acc-concurrency', 5);
    const emailInput = document.getElementById('input-acc-email');
    if (emailInput && typeof emailInput.focus === 'function') {
      setTimeout(() => emailInput.focus(), 60);
    }
  }
};

async function startOauthLogin() {
  const popup = window.open('', 'antigravity-google-oauth', 'popup,width=560,height=720');
  const originalHtml = btnOauthLogin ? btnOauthLogin.innerHTML : '';
  if (btnOauthLogin) {
    btnOauthLogin.disabled = true;
    btnOauthLogin.innerText = '正在打开授权...';
  }

  try {
    const result = await apiRequest('/api/admin/oauth/start', { method: 'POST' });
    if (popup) {
      popup.location.href = result.authUrl;
    } else {
      window.location.href = result.authUrl;
    }
    showToast('请在打开的 Google 页面完成授权，完成后账号会自动加入账号池', 'info');
  } catch (error) {
    if (popup) popup.close();
    showToast(`无法发起 Google 授权: ${error.message}`, 'error');
  } finally {
    if (btnOauthLogin) {
      btnOauthLogin.disabled = false;
      btnOauthLogin.innerHTML = originalHtml;
    }
  }
}

window.closeAddModal = function() {
  const modal = document.getElementById('add-modal');
  if (modal) modal.style.display = 'none';
};

window.openProxyModal = function(accId) {
  const acc = cachedAccounts.find(a => a.id === accId);
  if (!acc) return;

  const idInput = document.getElementById('proxy-modal-acc-id');
  const emailEl = document.getElementById('proxy-modal-email');
  const proxyInput = document.getElementById('input-edit-proxy');
  const modal = document.getElementById('proxy-modal');

  if (idInput) idInput.value = acc.id;
  if (emailEl) emailEl.innerText = `${acc.email} (${acc.id})`;

  const curProxy = acc.proxyUrl || '';
  if (proxyInput) {
    proxyInput.value = curProxy;
    updateProxyPresetChipsActive(curProxy);
  }

  const curConc = acc.maxConcurrency || 5;
  setConcurrency('input-edit-concurrency', curConc);

  if (modal) modal.style.display = 'flex';
};

window.closeProxyModal = function() {
  const modal = document.getElementById('proxy-modal');
  if (modal) modal.style.display = 'none';
};

window.applyProxyPreset = function(url) {
  const proxyInput = document.getElementById('input-edit-proxy');
  if (proxyInput) {
    proxyInput.value = url;
    updateProxyPresetChipsActive(url);
    if (typeof proxyInput.focus === 'function') proxyInput.focus();
  }
};

function updateProxyPresetChipsActive(currentVal) {
  const chips = document.querySelectorAll('.proxy-presets-wrap .preset-chip');
  chips.forEach(chip => {
    const chipVal = chip.getAttribute('data-url') ?? '';
    if (chipVal === currentVal) {
      chip.classList.add('active');
    } else {
      chip.classList.remove('active');
    }
  });
}

window.stepConcurrency = function(inputId, delta) {
  const el = document.getElementById(inputId);
  if (!el) return;
  let val = parseInt(el.value, 10) || 5;
  val = Math.max(1, Math.min(50, val + delta));
  el.value = val;
  updateQuickChipsActive(inputId, val);
};

window.setConcurrency = function(inputId, val) {
  const el = document.getElementById(inputId);
  if (!el) return;
  const num = Math.max(1, Math.min(50, parseInt(val, 10) || 5));
  el.value = num;
  updateQuickChipsActive(inputId, num);
};

window.onConcurrencyInput = function(inputEl) {
  if (!inputEl) return;
  let val = parseInt(inputEl.value, 10);
  if (isNaN(val)) return;
  val = Math.max(1, Math.min(50, val));
  updateQuickChipsActive(inputEl.id, val);
};

function updateQuickChipsActive(inputId, val) {
  const chips = document.querySelectorAll(`.step-chip[data-target="${inputId}"]`);
  chips.forEach(chip => {
    const chipVal = parseInt(chip.getAttribute('data-val'), 10);
    if (chipVal === val) {
      chip.classList.add('active');
    } else {
      chip.classList.remove('active');
    }
  });
}

window.manualRefreshData = function(btn) {
  const b = btn || document.getElementById('btn-refresh-data');
  if (b) b.disabled = true;
  loadAllData().finally(() => {
    setTimeout(() => { if (b) b.disabled = false; }, 300);
    showToast('数据已刷新', 'info');
  });
};

window.handleLogout = function() {
  localStorage.removeItem('antigravity_admin_pass');
  adminPassword = '';
  stopDataPolling();
  const overlay = document.getElementById('login-overlay');
  if (overlay) overlay.style.display = 'flex';
  showToast('已安全退出登录', 'info');
};

window.handleAddAccount = async function() {
  const emailInput = document.getElementById('input-acc-email');
  const tokenInput = document.getElementById('input-acc-token');
  const proxyInput = document.getElementById('input-acc-proxy');
  const concInput = document.getElementById('input-acc-concurrency');
  const submitBtn = document.getElementById('btn-submit-add');

  const email = emailInput ? emailInput.value.trim() : '';
  const token = tokenInput ? tokenInput.value.trim() : '';
  let proxy = proxyInput ? proxyInput.value.trim() : '';
  const concurrency = concInput ? (parseInt(concInput.value, 10) || 5) : 5;

  if (!email || !token) {
    showToast('请填写 Google 邮箱和 Refresh Token', 'error');
    return;
  }

  if (proxy && !/^https?:\/\/|^socks5?:\/\//i.test(proxy)) {
    proxy = 'http://' + proxy;
  }

  const origText = submitBtn ? submitBtn.innerText : '';
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.innerText = '保存中...';
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

    closeAddModal();
    if (emailInput) emailInput.value = '';
    if (tokenInput) tokenInput.value = '';
    if (proxyInput) proxyInput.value = '';
    setConcurrency('input-acc-concurrency', 5);
    showToast('账号已成功加入调度集群', 'success');
    loadAllData();
  } catch (e) {
    showToast('添加账号失败: ' + e.message, 'error');
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.innerText = origText || '保存并接入网关';
    }
  }
};

window.handleSaveProxyConfig = async function() {
  const idInput = document.getElementById('proxy-modal-acc-id');
  const proxyInput = document.getElementById('input-edit-proxy');
  const concInput = document.getElementById('input-edit-concurrency');
  const submitBtn = document.getElementById('btn-submit-proxy');

  const accId = idInput ? idInput.value : '';
  if (!accId) return;

  let proxyUrl = proxyInput ? proxyInput.value.trim() : '';
  if (proxyUrl && !/^https?:\/\/|^socks5?:\/\//i.test(proxyUrl)) {
    proxyUrl = 'http://' + proxyUrl;
    if (proxyInput) proxyInput.value = proxyUrl;
  }
  const maxConcurrency = concInput ? (parseInt(concInput.value, 10) || 5) : 5;

  const origText = submitBtn ? submitBtn.innerText : '';
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.innerText = '保存中...';
  }

  try {
    const res = await apiRequest(`/api/admin/accounts/${accId}`, {
      method: 'PUT',
      body: JSON.stringify({ proxyUrl, maxConcurrency })
    });

    showToast(res.message || '出口代理与并发配置已更新', 'success');
    closeProxyModal();

    // 立即就地更新前端缓存并触发差量重绘
    const acc = cachedAccounts.find(a => a.id === accId);
    if (acc) {
      acc.proxyUrl = proxyUrl || undefined;
      acc.maxConcurrency = maxConcurrency;
      updateCardInPlace(acc);
    }
    loadAllData();
  } catch (err) {
    showToast('保存代理设置失败: ' + err.message, 'error');
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.innerText = origText || '保 存 配 置';
    }
  }
};

window.checkQuota = async function(id, btn) {
  const origHtml = btn ? btn.innerHTML : '';
  if (btn) {
    btn.disabled = true;
    btn.innerText = '查询中...';
  }
  try {
    const res = await apiRequest(`/api/admin/accounts/${id}/quota`, { method: 'POST' });
    if (res.success) {
      showToast('配额已拉取更新', 'success');
      loadAllData();
    } else {
      showToast('获取配额失败，请检查账号状态或代理', 'error');
    }
  } catch (e) {
    showToast('查询失败: ' + e.message, 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = origHtml;
    }
  }
};

window.refreshToken = async function(id, btn) {
  const origHtml = btn ? btn.innerHTML : '';
  if (btn) {
    btn.disabled = true;
    btn.innerText = '刷新中...';
  }
  try {
    const res = await apiRequest(`/api/admin/accounts/${id}/refresh`, { method: 'POST' });
    if (res.success) {
      showToast('Token 刷新成功', 'success');
      loadAllData();
    } else {
      showToast('Token 刷新失败，请检查 Refresh Token 是否有效', 'error');
    }
  } catch (e) {
    showToast('请求失败: ' + e.message, 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = origHtml;
    }
  }
};

window.resetAccount = async function(id, btn) {
  const origHtml = btn ? btn.innerHTML : '';
  if (btn) {
    btn.disabled = true;
    btn.innerText = '激活中...';
  }
  try {
    await apiRequest(`/api/admin/accounts/${id}/reset`, { method: 'POST' });
    showToast('账号状态已重置为 Active', 'success');
    loadAllData();
  } catch (e) {
    showToast('操作失败: ' + e.message, 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = origHtml;
    }
  }
};

window.toggleAccountDisabled = async function(id, isDisabled, btn) {
  const nextStatus = isDisabled ? 'active' : 'disabled';
  const action = isDisabled ? '启用' : '停用';
  if (!confirm(`确定要${action}这个账号吗？`)) return;

  const origHtml = btn ? btn.innerHTML : '';
  if (btn) {
    btn.disabled = true;
    btn.innerText = isDisabled ? '启用中...' : '停用中...';
  }
  try {
    const res = await apiRequest(`/api/admin/accounts/${id}/status`, {
      method: 'PUT',
      body: JSON.stringify({ status: nextStatus })
    });
    showToast(res.message, 'success');
    loadAllData();
  } catch (e) {
    showToast(`${action}失败: ${e.message}`, 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = origHtml;
    }
  }
};

window.deleteAccount = async function(id, btn) {
  if (!confirm('确定要从账号池中彻底删除该账号吗？')) return;
  const origHtml = btn ? btn.innerHTML : '';
  if (btn) {
    btn.disabled = true;
    btn.innerText = '...';
  }
  try {
    await apiRequest(`/api/admin/accounts/${id}`, { method: 'DELETE' });
    showToast('账号已从调度集群彻底移除', 'success');
    loadAllData();
  } catch (e) {
    showToast('删除失败: ' + e.message, 'error');
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = origHtml;
    }
  }
};

function copyText(text, label) {
  navigator.clipboard.writeText(text).then(() => {
    showToast(`已复制 ${label}: ${text}`, 'success');
  });
}

function showToast(message, type = 'info') {
  let container = document.querySelector('.toast-container');
  if (!container) {
    container = document.createElement('div');
    container.className = 'toast-container';
    document.body.appendChild(container);
  }
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `<span>${escapeHtml(message)}</span>`;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => {
      if (toast && typeof toast.remove === 'function') {
        toast.remove();
      } else if (toast && toast.parentNode) {
        toast.parentNode.removeChild(toast);
      }
    }, 300);
  }, 3500);
}

function escapeHtml(text) {
  if (!text) return '';
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

document.addEventListener('DOMContentLoaded', init);
