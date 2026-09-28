const form = document.getElementById('signup-form');
const errorEl = document.getElementById('form-error');
const successEl = document.getElementById('success');
const successMsg = document.getElementById('success-msg');
const successMeta = document.getElementById('success-meta');
const submitBtn = document.getElementById('submit-btn');

function showError(message) {
  errorEl.hidden = !message;
  errorEl.textContent = message || '';
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  showError('');

  const data = new FormData(form);
  const apiToken = String(data.get('apiToken') || '').trim();
  const payload = {
    name: String(data.get('name') || '').trim(),
    email: String(data.get('email') || '').trim() || null,
    phone: String(data.get('phone') || '').trim(),
    plan: String(data.get('plan') || 'claude'),
  };

  if (!apiToken) {
    showError('Admin API token required (ROCKY_API_TOKEN).');
    return;
  }
  if (!payload.name || payload.name.length < 2) {
    showError('Enter your full name.');
    return;
  }
  if (!payload.phone) {
    showError('Enter your WhatsApp number with country code.');
    return;
  }

  submitBtn.disabled = true;
  submitBtn.textContent = 'Provisioning…';

  try {
    const res = await fetch('/api/signup', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiToken}`,
      },
      body: JSON.stringify(payload),
    });
    const body = await res.json();
    if (!res.ok || !body.ok) {
      throw new Error(body.error || 'Signup failed');
    }

    form.hidden = true;
    successEl.hidden = false;
    successMsg.textContent = body.next?.message || 'Your workspace is ready.';
    successMeta.textContent = `${body.tenant.name} · +${body.tenant.phone} · ${body.tenant.plan} · ${body.tenant.state}`;
  } catch (err) {
    showError(err.message || String(err));
    submitBtn.disabled = false;
    submitBtn.textContent = 'Create my Rocky';
  }
});
