// ===== Result Panel =====
const resultEl = document.getElementById('result');
let currentTimeout = null;

function showResult(type, title, lines) {
  if (currentTimeout) {
    clearTimeout(currentTimeout);
    currentTimeout = null;
  }

  let html = '';
  if (title) {
    html += `<div class="result-title">${title}</div>`;
  }
  if (lines && lines.length) {
    html += lines.map(line => `<div class="result-line">${line}</div>`).join('');
  }

  resultEl.className = 'result-panel ' + type;
  resultEl.innerHTML = html;
  resultEl.classList.remove('hidden');

  // 结果面板在页面底部：显示后滚入视口，否则用户以为"点了没反应"
  try {
    resultEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch {
    // ignore
  }

  // Auto-hide success after 10s
  if (type === 'success') {
    currentTimeout = setTimeout(() => {
      resultEl.classList.add('hidden');
    }, 10000);
  }
}

function showLoading(msg) {
  showResult('loading', `<span class="spinner"></span> ${msg}`, []);
}

function showError(title, detail) {
  showResult('error', '&#10060; ' + title, detail ? [`${detail}`] : []);
}

function showCreated(domain, authCode) {
  const lines = [
    `<span style="color:var(--text-primary);font-weight:500;">域名：</span> <span class="result-value" onclick="copyText('${domain}')">${domain} <span class="copy-hint">点击复制</span></span>`,
    `<span style="color:var(--text-primary);font-weight:500;">授权码：</span> <span class="result-value" onclick="copyText('${authCode}')">${authCode} <span class="copy-hint">点击复制</span></span>`
  ];
  showResult('success', '&#9989; 创建成功', lines);
  fillManageSection(domain, authCode);
}

function showSimpleSuccess(msg) {
  showResult('success', '&#9989; ' + msg, []);
}

// ===== Copy to Clipboard =====
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    showToast('已复制到剪贴板');
  } catch {
    // Fallback
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      showToast('已复制到剪贴板');
    } catch {
      // Fail silently
    }
    document.body.removeChild(ta);
  }
}

// ===== Toast =====
function showToast(msg) {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = msg;
  document.body.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, 2000);
}

// ===== Auto-fill management section =====
function fillManageSection(domain, authCode) {
  const prefix = domain.split('.')[0];
  document.getElementById('sub').value = prefix || '';
  document.getElementById('authCode').value = authCode || '';
}

// ===== Request Helpers =====
async function request(url, data, opts = {}) {
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(data || {})
    });
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      return { error: text };
    }
  } catch (e) {
    if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
      return { error: '连接论坛超时，请检查网络后重试' };
    }
    return { error: e.message || '网络异常' };
  }
}

async function getRequest(url, token) {
  try {
    const res = await fetch(url, {
      headers: token ? { 'Authorization': `Bearer ${token}` } : {}
    });
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      return { error: text };
    }
  } catch (e) {
    if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
      return { error: '连接论坛超时，请检查网络后重试' };
    }
    return { error: e.message || '网络异常' };
  }
}

// ===== Disable / Enable Buttons =====
function setButtonsLoading(loading) {
  document.querySelectorAll('.btn').forEach(btn => {
    btn.disabled = loading;
    btn.style.opacity = loading ? '0.6' : '1';
    btn.style.cursor = loading ? 'not-allowed' : 'pointer';
  });
}

// ===== 站点配置 =====
const siteConfig = {
  loaded: false,
  turnstile: { enabled: false, siteKey: '', action: 'create' },
  forum: { apiBase: 'https://i.182030.xyz', turnstileSiteKey: null, registerUrl: 'https://forum.182030.xyz/register' }
};

async function loadSiteConfig() {
  try {
    const res = await fetch('/api/config');
    const cfg = await res.json();
    if (cfg && cfg.turnstile) siteConfig.turnstile = cfg.turnstile;
    if (cfg && cfg.forum) siteConfig.forum = cfg.forum;
    siteConfig.loaded = true;
  } catch {
    // 拿不到配置按未启用处理；服务端仍会独立校验
  }
  const link = document.getElementById('register-link');
  if (link && siteConfig.forum.registerUrl) link.href = siteConfig.forum.registerUrl;
}

// ===== Cloudflare Turnstile（匿名创建用） =====
const turnstile = {
  enabled: false,
  action: 'create',
  widgetId: null,
  token: ''
};

function setTurnstileStatus(msg) {
  const el = document.getElementById('turnstile-status');
  if (el) el.textContent = msg || '';
}

function loadTurnstileScript() {
  return new Promise(resolve => {
    if (window.turnstile) {
      resolve(true);
      return;
    }

    window.onTurnstileLoad = () => resolve(true);

    const script = document.createElement('script');
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=onTurnstileLoad';
    script.async = true;
    script.defer = true;
    script.onerror = () => resolve(false);
    document.head.appendChild(script);

    // 兜底：脚本被广告拦截器之类挡掉时不要永远挂起
    setTimeout(() => resolve(Boolean(window.turnstile)), 10000);
  });
}

async function initCreateTurnstile() {
  const conf = siteConfig.turnstile;
  if (!conf.enabled || !conf.siteKey) return;

  turnstile.enabled = true;
  turnstile.action = conf.action || 'create';

  const slot = document.getElementById('turnstile-slot');
  if (slot) slot.classList.remove('hidden');

  const loaded = await loadTurnstileScript();
  if (!loaded) {
    setTurnstileStatus('人机验证组件加载失败，请刷新页面重试');
    return;
  }

  turnstile.widgetId = window.turnstile.render('#turnstile-widget', {
    sitekey: conf.siteKey,
    action: turnstile.action,
    callback: token => {
      turnstile.token = token;
      setTurnstileStatus('');
    },
    'expired-callback': () => {
      turnstile.token = '';
      setTurnstileStatus('验证已过期，请重新验证');
    },
    'timeout-callback': () => {
      turnstile.token = '';
      setTurnstileStatus('验证超时，请重新验证');
    },
    'error-callback': () => {
      turnstile.token = '';
      setTurnstileStatus('人机验证出错，请重新验证');
    }
  });
}

// Turnstile 令牌是一次性的：每次请求结束后都必须 reset，否则重试必然失败
function resetTurnstile() {
  if (!turnstile.enabled) return;

  turnstile.token = '';

  if (turnstile.widgetId !== null && window.turnstile) {
    try {
      window.turnstile.reset(turnstile.widgetId);
    } catch {
      // 组件已被移除等情况，忽略
    }
  }
}

// ===== 论坛账号系统 =====
const AUTH_KEY = 'mc_forum_auth';
const auth = {
  user: null,
  accessToken: '',
  refreshToken: '',
  exp: 0
};

// 论坛登录用的人机验证（论坛自己的 Turnstile 站点，与「创建」的验证组件相互独立）
const forumTurnstile = {
  enabled: false,
  widgetId: null,
  token: ''
};

function setForumTurnstileStatus(msg) {
  const el = document.getElementById('forum-turnstile-status');
  if (el) el.textContent = msg || '';
}

async function initForumTurnstile() {
  const siteKey = siteConfig.forum.turnstileSiteKey;
  if (!siteKey) return; // 论坛未启用验证（如本地开发）则不渲染

  forumTurnstile.enabled = true;
  const slot = document.getElementById('forum-turnstile-slot');
  if (slot) slot.classList.remove('hidden');

  const loaded = await loadTurnstileScript();
  if (!loaded) {
    setForumTurnstileStatus('人机验证组件加载失败，请刷新页面重试');
    return;
  }

  forumTurnstile.widgetId = window.turnstile.render('#forum-turnstile-widget', {
    sitekey: siteKey,
    callback: token => {
      forumTurnstile.token = token;
      setForumTurnstileStatus('');
    },
    'expired-callback': () => {
      forumTurnstile.token = '';
      setForumTurnstileStatus('验证已过期，请重新验证');
    },
    'error-callback': () => {
      forumTurnstile.token = '';
      setForumTurnstileStatus('人机验证出错，请重新验证');
    }
  });
}

function resetForumTurnstile() {
  if (!forumTurnstile.enabled) return;
  forumTurnstile.token = '';
  if (forumTurnstile.widgetId !== null && window.turnstile) {
    try {
      window.turnstile.reset(forumTurnstile.widgetId);
    } catch {
      // ignore
    }
  }
}

/** 账号卡片内联状态（比底部结果面板更靠近操作点，登录相关反馈一律走这里） */
function setAuthStatus(msg, isError) {
  const el = document.getElementById('login-status');
  if (!el) return;
  el.textContent = msg || '';
  el.classList.toggle('hidden', !msg);
  el.classList.toggle('error', !!isError);
}

function saveAuth() {
  localStorage.setItem(AUTH_KEY, JSON.stringify({
    user: auth.user,
    accessToken: auth.accessToken,
    refreshToken: auth.refreshToken,
    exp: auth.exp
  }));
}

function clearAuth() {
  auth.user = null;
  auth.accessToken = '';
  auth.refreshToken = '';
  auth.exp = 0;
  localStorage.removeItem(AUTH_KEY);
}

function loadAuth() {
  try {
    const raw = localStorage.getItem(AUTH_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (data && data.accessToken && data.refreshToken) {
      auth.user = data.user || null;
      auth.accessToken = data.accessToken;
      auth.refreshToken = data.refreshToken;
      auth.exp = data.exp || 0;
    }
  } catch {
    clearAuth();
  }
}

function avatarUrl(user) {
  const base = (siteConfig.forum.apiBase || '').replace(/\/+$/, '');
  const raw = user && (user.avatarUrl || user.avatar_url);
  if (!raw) return '';
  if (/^https?:\/\//.test(raw)) return raw;
  return base + raw;
}

function renderAuthState() {
  const loggedInEl = document.getElementById('auth-logged-in');
  const loggedOutEl = document.getElementById('auth-logged-out');
  const recordsCard = document.getElementById('records-card');

  if (auth.user) {
    loggedInEl.classList.remove('hidden');
    loggedOutEl.classList.add('hidden');
    recordsCard.classList.remove('hidden');

    const nickname = auth.user.nickname || auth.user.username || '论坛用户';
    document.getElementById('user-nickname').textContent = nickname;
    document.getElementById('user-username').textContent = auth.user.username ? '@' + auth.user.username : '';
    const img = document.getElementById('user-avatar');
    const url = avatarUrl(auth.user);
    if (url) {
      img.src = url;
      img.classList.remove('hidden');
    } else {
      img.classList.add('hidden');
    }
    loadMyRecords();
  } else {
    loggedInEl.classList.add('hidden');
    loggedOutEl.classList.remove('hidden');
    recordsCard.classList.add('hidden');
  }
}

function decodeJwtPayload(token) {
  try {
    const part = token.split('.')[1];
    const pad = part.length % 4 === 0 ? '' : '='.repeat(4 - (part.length % 4));
    return JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/') + pad));
  } catch {
    return null;
  }
}

async function forumApi(path, body, opts = {}) {
  const base = (siteConfig.forum.apiBase || 'https://i.182030.xyz').replace(/\/+$/, '');
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
    const res = await fetch(base + path, {
      method: opts.method || (body !== undefined ? 'POST' : 'GET'),
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      // 论坛不可达/被墙时不能无限等待：否则按钮一直是禁用态，看起来"点了没反应"
      signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(20000) : undefined
    });
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      return { error: text || `HTTP ${res.status}` };
    }
  } catch (e) {
    if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
      return { error: '连接论坛超时，请检查网络后重试' };
    }
    return { error: e.message || '网络异常' };
  }
}

/** 用 Refresh Token 换新 Access Token（论坛侧轮换） */
async function refreshAccessToken() {
  if (!auth.refreshToken) return false;
  const res = await forumApi('/api/auth/refresh', { refreshToken: auth.refreshToken });
  if (res && res.accessToken && res.refreshToken) {
    auth.accessToken = res.accessToken;
    auth.refreshToken = res.refreshToken;
    const payload = decodeJwtPayload(res.accessToken);
    auth.exp = (payload && payload.exp ? payload.exp : Math.floor(Date.now() / 1000) + (res.accessExpiresIn || 1800));
    saveAuth();
    return true;
  }
  clearAuth();
  renderAuthState();
  return false;
}

/** 确保本地 Access Token 未过期（提前 60s 刷新）；失败时清除登录态并返回 false */
async function ensureFreshToken() {
  if (!auth.accessToken) return false;
  const now = Math.floor(Date.now() / 1000);
  if (auth.exp && auth.exp - 60 > now) return true;
  return refreshAccessToken();
}

/** 登录 */
async function login() {
  const identifier = document.getElementById('login-identifier').value.trim();
  const password = document.getElementById('login-password').value;

  if (!identifier || !password) {
    setAuthStatus('请填写用户名和密码', true);
    return;
  }
  if (forumTurnstile.enabled && !forumTurnstile.token) {
    setAuthStatus('请先完成下方的人机验证，再点登录', true);
    return;
  }

  const btn = document.getElementById('login-btn');
  const originalHtml = btn.innerHTML;
  btn.disabled = true;
  btn.style.opacity = '0.6';
  btn.textContent = '登录中…';
  setAuthStatus('正在登录论坛账号…', false);

  const body = { identifier, password };
  if (forumTurnstile.enabled) body.turnstileToken = forumTurnstile.token;

  let res;
  try {
    res = await forumApi('/api/auth/login', body);
  } finally {
    btn.disabled = false;
    btn.style.opacity = '1';
    btn.innerHTML = originalHtml;
    resetForumTurnstile();
  }

  if (res && res.error) {
    setAuthStatus('登录失败：' + (res.error.message || res.error), true);
    return;
  }
  if (!res || !res.accessToken) {
    setAuthStatus('登录失败：论坛服务未返回有效凭证', true);
    return;
  }

  auth.user = res.user || null;
  auth.accessToken = res.accessToken;
  auth.refreshToken = res.refreshToken;
  const payload = decodeJwtPayload(res.accessToken);
  auth.exp = (payload && payload.exp ? payload.exp : Math.floor(Date.now() / 1000) + (res.accessExpiresIn || 1800));
  saveAuth();

  document.getElementById('login-password').value = '';
  setAuthStatus('');
  renderAuthState();
  showSimpleSuccess('登录成功，欢迎 ' + (auth.user && (auth.user.nickname || auth.user.username) || ''));
}

/**
 * 同步论坛登录状态：弹窗打开论坛同源桥接页（第一方上下文才能读到论坛自己的登录态，
 * 第三方 iframe 的 localStorage 被浏览器分区，读不到），通过 postMessage 握手取回凭证。
 */
async function syncForumLogin() {
  const origin = (siteConfig.forum.ssoOrigin || 'https://forum.182030.xyz').replace(/\/+$/, '');
  if (auth.accessToken) {
    setAuthStatus('当前已登录：@' + ((auth.user && auth.user.username) || ''), false);
    return;
  }

  const btn = document.getElementById('sync-btn');
  const originalHtml = btn ? btn.innerHTML : '';
  if (btn) { btn.disabled = true; btn.style.opacity = '0.6'; btn.textContent = '正在同步…'; }
  setAuthStatus('正在打开论坛登录同步窗口…（若被拦截请允许本站弹窗）', false);

  const popup = window.open(
    origin + '/sso-bridge',
    'starlr-sso-bridge',
    'width=460,height=420,menubar=no,toolbar=no,location=no,status=no'
  );

  const restoreBtn = () => {
    if (btn) { btn.disabled = false; btn.style.opacity = '1'; btn.innerHTML = originalHtml; }
  };

  if (!popup) {
    restoreBtn();
    setAuthStatus('浏览器拦截了弹窗：请允许本站弹窗后重试，或直接输入账号密码登录', true);
    return;
  }

  let done = false;
  let pingTimer = null;
  let timeoutTimer = null;

  const finish = (msg, isError) => {
    if (done) return;
    done = true;
    if (pingTimer) clearInterval(pingTimer);
    if (timeoutTimer) clearTimeout(timeoutTimer);
    window.removeEventListener('message', onMessage);
    restoreBtn();
    try { if (!popup.closed) popup.close(); } catch { /* ignore */ }
    if (msg !== null) setAuthStatus(msg, isError);
  };

  const onMessage = (e) => {
    if (e.origin !== origin) return;              // 只信任论坛源
    const d = e.data;
    if (!d || d.type !== 'starlr-sso-response') return;

    if (!d.ok || !d.accessToken) {
      finish('论坛当前未登录（或登录状态已失效），请直接输入账号密码登录', true);
      return;
    }

    auth.user = d.user || null;
    auth.accessToken = d.accessToken;
    auth.refreshToken = d.refreshToken || '';
    const payload = decodeJwtPayload(auth.accessToken);
    auth.exp = payload && payload.exp ? payload.exp : 0;
    saveAuth();

    const name = (auth.user && (auth.user.nickname || auth.user.username)) || '论坛账号';
    finish('已同步论坛登录状态，欢迎 ' + name, false);
    renderAuthState();
    showSimpleSuccess('已同步论坛登录状态，欢迎 ' + name);
  };

  window.addEventListener('message', onMessage);

  const ping = () => {
    try { popup.postMessage({ type: 'starlr-sso-request' }, origin); } catch { /* ignore */ }
  };
  // 桥接页可能仍在加载：轮询握手直到收到响应、用户关窗或超时
  pingTimer = setInterval(() => {
    if (popup.closed) { finish('已取消论坛登录同步', false); return; }
    ping();
  }, 600);
  ping();
  timeoutTimer = setTimeout(() => finish('论坛登录同步超时，请直接输入账号密码登录', true), 20000);
}

/** 登出（撤销论坛侧会话 + 清理本地） */
async function logout() {
  if (auth.refreshToken) {
    await forumApi('/api/auth/logout', { refreshToken: auth.refreshToken });
  }
  clearAuth();
  resetForumTurnstile();
  setAuthStatus('已退出登录，可重新登录或继续匿名使用', false);
  renderAuthState();
  showSimpleSuccess('已退出登录');
}

/** 页面加载时恢复登录态 */
async function initAuth() {
  loadAuth();
  if (!auth.accessToken) {
    renderAuthState();
    return;
  }
  // 校验并拉取最新资料
  if (!(await ensureFreshToken())) {
    renderAuthState();
    return;
  }
  const me = await forumApi('/api/auth/me', undefined, { token: auth.accessToken });
  if (me && me.user) {
    auth.user = me.user;
    saveAuth();
    renderAuthState();
  } else if (me && me.error && (me.error.code === 'TOKEN_EXPIRED' || me.error.code === 'INVALID_TOKEN')) {
    if (await refreshAccessToken()) {
      return initAuth();
    }
    renderAuthState();
  } else {
    // 论坛暂时不可达等：保留本地登录态
    renderAuthState();
  }
}

// ===== 我的域名 =====
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[ch]);
}

function formatTime(ts) {
  if (!ts) return '—';
  const d = new Date(Number(ts));
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleString('zh-CN', { hour12: false });
}

async function loadMyRecords() {
  if (!auth.user) return;
  if (!(await ensureFreshToken())) return;

  const listEl = document.getElementById('records-list');
  listEl.innerHTML = '<div class="records-loading">加载中...</div>';

  const res = await getRequest('/api/my/records', auth.accessToken);

  // Token 失效：刷新后重试一次
  if (res && res.code === 'AUTH_INVALID') {
    if (await refreshAccessToken()) return loadMyRecords();
    listEl.innerHTML = '<div class="records-empty">登录状态已失效，请重新登录</div>';
    return;
  }
  if (res && res.error) {
    listEl.innerHTML = `<div class="records-empty">${escapeHtml(res.error.message || res.error)}</div>`;
    return;
  }

  const records = (res && res.records) || [];
  if (records.length === 0) {
    listEl.innerHTML = '<div class="records-empty">还没有绑定任何域名，创建一个或认领历史域名吧。</div>';
    return;
  }

  listEl.innerHTML = records.map(r => `
    <div class="record-item">
      <div class="record-info">
        <div class="record-domain">${escapeHtml(r.domain)}</div>
        <div class="record-target">${escapeHtml(r.target)}:${escapeHtml(r.port)} · ${escapeHtml(formatTime(r.created))}</div>
      </div>
      <div class="record-actions">
        <button class="btn btn-ghost btn-sm" onclick="editFromList('${escapeHtml(r.sub)}', '${escapeHtml(r.target)}', ${Number(r.port) || 25565})">修改</button>
        <button class="btn btn-danger btn-sm" onclick="deleteFromList('${escapeHtml(r.sub)}')">删除</button>
      </div>
    </div>
  `).join('');
}

function editFromList(sub, target, port) {
  document.getElementById('sub').value = sub;
  document.getElementById('newAddress').value = `${target}:${port}`;
  document.getElementById('authCode').value = '';
  document.getElementById('sub').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

async function deleteFromList(sub) {
  if (!confirm(`确定要删除 "${sub}" 的所有解析记录吗？`)) return;

  if (!(await ensureFreshToken())) return;
  setButtonsLoading(true);
  showLoading('正在删除解析...');

  const res = await request('/api/delete', { sub }, { token: auth.accessToken });

  setButtonsLoading(false);

  if (res && res.code === 'AUTH_INVALID') {
    if (await refreshAccessToken()) return deleteFromList(sub);
    showError('登录状态已失效', '请重新登录后再试');
    return;
  }
  if (res && res.error) {
    showError('删除失败', res.error.message || res.error);
    return;
  }

  showSimpleSuccess('解析记录已删除');
  loadMyRecords();
}

async function claimRecord() {
  const sub = document.getElementById('claim-sub').value.trim().toLowerCase();
  const authCode = document.getElementById('claim-authcode').value.trim();

  if (!sub || !authCode) {
    showError('请填写完整信息', '认领需要前缀和对应的授权码');
    return;
  }
  if (!(await ensureFreshToken())) return;

  setButtonsLoading(true);
  showLoading('正在认领...');

  const res = await request('/api/claim', { sub, authCode }, { token: auth.accessToken });

  setButtonsLoading(false);

  if (res && res.code === 'AUTH_INVALID') {
    if (await refreshAccessToken()) return claimRecord();
    showError('登录状态已失效', '请重新登录后再试');
    return;
  }
  if (res && res.error) {
    showError('认领失败', res.error.message || res.error);
    return;
  }

  document.getElementById('claim-sub').value = '';
  document.getElementById('claim-authcode').value = '';
  showSimpleSuccess('认领成功：' + ((res.record && res.record.domain) || sub));
  loadMyRecords();
}

// ===== Create =====
async function create() {
  const address = document.getElementById('address').value.trim();
  const prefix = document.getElementById('prefix').value.trim();

  if (!address) {
    showError('请输入服务器地址', '格式：example.com:25565 或 1.1.1.1:25565');
    document.getElementById('address').focus();
    return;
  }

  // 刷新登录态：成功保留登录身份，失败则按匿名（需要人机验证）
  const loggedIn = auth.accessToken ? await ensureFreshToken() : false;

  if (!loggedIn && turnstile.enabled && !turnstile.token) {
    showError('请先完成人机验证', '完成上方的人机验证后即可生成域名');
    return;
  }

  setButtonsLoading(true);
  showLoading('正在生成域名...');

  const payload = { address, prefix };
  if (!loggedIn && turnstile.enabled) payload['cf-turnstile-response'] = turnstile.token;

  const res = await request('/api/create', payload, { token: auth.accessToken || undefined });

  setButtonsLoading(false);
  if (!loggedIn) resetTurnstile();

  if (res && res.code === 'AUTH_INVALID') {
    if (await refreshAccessToken()) return create();
    showError('登录状态已失效', '请重新登录后再试');
    return;
  }

  if (res && res.error) {
    showError('创建失败', res.error.message || res.error);
    return;
  }

  showCreated(res.domain, res.authCode);
  if (res.bound) loadMyRecords();
}

// ===== Update =====
async function update() {
  const sub = document.getElementById('sub').value.trim();
  const address = document.getElementById('newAddress').value.trim();
  const authCode = document.getElementById('authCode').value.trim();

  if (!sub || !address) {
    showError('请填写完整信息', '前缀和新地址为必填项；授权码未登录时必填');
    return;
  }

  const parts = address.split(':');
  if (parts.length !== 2) {
    showError('地址格式错误', '必须为 host:port 格式，例如 play.example.com:25565');
    return;
  }

  const target = parts[0].trim();
  const port = Number(parts[1]);

  if (!target || !port || isNaN(port)) {
    showError('地址解析失败', '请检查地址格式');
    return;
  }

  if (!authCode && !auth.accessToken) {
    showError('请填写授权码', '或先在上方登录论坛账号');
    return;
  }

  if (auth.accessToken) await ensureFreshToken();

  setButtonsLoading(true);
  showLoading('正在修改解析...');

  const res = await request('/api/update', {
    sub,
    target,
    port,
    authCode: authCode || undefined
  }, { token: auth.accessToken || undefined });

  setButtonsLoading(false);

  if (res && res.code === 'AUTH_INVALID') {
    if (await refreshAccessToken()) return update();
    showError('登录状态已失效', '请重新登录后再试');
    return;
  }

  if (res && res.error) {
    showError('修改失败', res.error.message || res.error);
    return;
  }

  showSimpleSuccess('解析修改成功');
  if (auth.accessToken) loadMyRecords();
}

// ===== Delete =====
async function deleteRecord() {
  const sub = document.getElementById('sub').value.trim();
  const authCode = document.getElementById('authCode').value.trim();

  if (!sub) {
    showError('请填写前缀', '要删除的记录前缀');
    return;
  }

  if (!authCode && !auth.accessToken) {
    showError('请填写授权码', '或先在上方登录论坛账号');
    return;
  }

  // Confirm
  if (!confirm(`确定要删除 "${sub}" 的所有解析记录吗？`)) {
    return;
  }

  if (auth.accessToken) await ensureFreshToken();

  setButtonsLoading(true);
  showLoading('正在删除解析...');

  const res = await request('/api/delete', {
    sub,
    authCode: authCode || undefined
  }, { token: auth.accessToken || undefined });

  setButtonsLoading(false);

  if (res && res.code === 'AUTH_INVALID') {
    if (await refreshAccessToken()) return deleteRecord();
    showError('登录状态已失效', '请重新登录后再试');
    return;
  }

  if (res && res.error) {
    showError('删除失败', res.error.message || res.error);
    return;
  }

  showSimpleSuccess('解析记录已删除');

  // Clear fields
  document.getElementById('sub').value = '';
  document.getElementById('authCode').value = '';
  document.getElementById('newAddress').value = '';

  if (auth.accessToken) loadMyRecords();
}

// ===== Keyboard shortcut =====
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const active = document.activeElement;
    if (active && (active.id === 'address' || active.id === 'prefix')) create();
    if (active && (active.id === 'login-identifier' || active.id === 'login-password')) login();
    if (active && (active.id === 'claim-sub' || active.id === 'claim-authcode')) claimRecord();
  }
});

// ===== Boot =====
(async function boot() {
  await loadSiteConfig();
  await initCreateTurnstile();
  await initForumTurnstile();
  await initAuth();
})();
