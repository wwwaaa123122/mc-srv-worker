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

// ===== Request Helper =====
async function request(url, data) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      return { error: text };
    }
  } catch (e) {
    return { error: e.message };
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

// ===== Cloudflare Turnstile (可选的人机验证) =====
// 由服务端 /api/config 决定是否启用；未启用时整段逻辑完全不参与。
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

async function initTurnstile() {
  let cfg;

  try {
    const res = await fetch('/api/config');
    cfg = await res.json();
  } catch {
    return; // 拿不到配置就当没开启；服务端仍会独立校验
  }

  const conf = (cfg && cfg.turnstile) || {};
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

// ===== Create =====
async function create() {
  const address = document.getElementById('address').value.trim();
  const prefix = document.getElementById('prefix').value.trim();

  if (!address) {
    showError('请输入服务器地址', '格式：example.com:25565 或 1.1.1.1:25565');
    document.getElementById('address').focus();
    return;
  }

  if (turnstile.enabled && !turnstile.token) {
    showError('请先完成人机验证', '完成上方的人机验证后即可生成域名');
    return;
  }

  setButtonsLoading(true);
  showLoading('正在生成域名...');

  const res = await request('/api/create', {
    address,
    prefix,
    'cf-turnstile-response': turnstile.token
  });

  setButtonsLoading(false);
  resetTurnstile();

  if (res.error) {
    showError('创建失败', res.error);
    return;
  }

  showCreated(res.domain, res.authCode);
}

// ===== Update =====
async function update() {
  const sub = document.getElementById('sub').value.trim();
  const address = document.getElementById('newAddress').value.trim();
  const authCode = document.getElementById('authCode').value.trim();

  if (!sub || !address || !authCode) {
    showError('请填写完整信息', '前缀、新地址和授权码均为必填项');
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

  setButtonsLoading(true);
  showLoading('正在修改解析...');

  const res = await request('/api/update', { sub, target, port, authCode });

  setButtonsLoading(false);

  if (res.error) {
    showError('修改失败', res.error);
    return;
  }

  showSimpleSuccess('解析修改成功');
}

// ===== Delete =====
async function deleteRecord() {
  const sub = document.getElementById('sub').value.trim();
  const authCode = document.getElementById('authCode').value.trim();

  if (!sub || !authCode) {
    showError('请填写完整信息', '前缀和授权码均为必填项');
    return;
  }

  // Confirm
  if (!confirm(`确定要删除 "${sub}" 的所有解析记录吗？`)) {
    return;
  }

  setButtonsLoading(true);
  showLoading('正在删除解析...');

  const res = await request('/api/delete', { sub, authCode });

  setButtonsLoading(false);

  if (res.error) {
    showError('删除失败', res.error);
    return;
  }

  showSimpleSuccess('解析记录已删除');

  // Clear fields
  document.getElementById('sub').value = '';
  document.getElementById('authCode').value = '';
  document.getElementById('newAddress').value = '';
}

// ===== Keyboard shortcut =====
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const active = document.activeElement;
    if (active && active.id === 'address') create();
  }
});

// ===== Boot =====
initTurnstile();