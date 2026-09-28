const params = new URLSearchParams(location.search);
const state = params.get('state') || '';

const authorizeEl = document.getElementById('authorize');
const form = document.getElementById('form');
const codeEl = document.getElementById('code');
const statusEl = document.getElementById('status');

async function loadSession() {
  if (!state) {
    statusEl.hidden = false;
    statusEl.className = 'err';
    statusEl.textContent = 'Missing link state. Send “connect claude” on WhatsApp for a fresh link.';
    form.querySelector('button').disabled = true;
    authorizeEl.removeAttribute('href');
    return;
  }
  try {
    const res = await fetch(`/api/connect/claude/session?state=${encodeURIComponent(state)}`);
    const body = await res.json();
    if (!res.ok || !body.ok) throw new Error(body.error || 'Session expired');
    authorizeEl.href = body.authorizeUrl;
  } catch (err) {
    statusEl.hidden = false;
    statusEl.className = 'err';
    statusEl.textContent = err.message || String(err);
    form.querySelector('button').disabled = true;
  }
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  statusEl.hidden = true;
  const code = String(codeEl.value || '').trim();
  if (!code) {
    statusEl.hidden = false;
    statusEl.className = 'err';
    statusEl.textContent = 'Paste the Claude authorization code first.';
    return;
  }
  try {
    const res = await fetch('/api/connect/claude', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state, code }),
    });
    const body = await res.json();
    if (!res.ok || !body.ok) throw new Error(body.error || 'Connect failed');
    statusEl.hidden = false;
    statusEl.className = 'ok';
    statusEl.textContent = body.message || 'Connected. You can close this tab and message Rocky on WhatsApp.';
    form.querySelector('button').disabled = true;
    codeEl.value = '';
  } catch (err) {
    statusEl.hidden = false;
    statusEl.className = 'err';
    statusEl.textContent = err.message || String(err);
  }
});

loadSession();
