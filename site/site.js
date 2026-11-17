'use strict';
// Sends the demo request form to the server and shows the result in place.
document.addEventListener('submit', async (e) => {
  const form = e.target.closest('form.lead');
  if (!form) return;
  e.preventDefault();
  const status = form.querySelector('.status'), button = form.querySelector('button[type=submit]');
  const body = Object.fromEntries(new FormData(form).entries());
  button.disabled = true; status.textContent = 'Sending';
  try {
    const res = await fetch('/api/contact', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || 'That did not go through. Try again in a minute.');
    form.reset(); status.textContent = 'Thank you. We have your request and will reply by email.';
  } catch (err) { status.textContent = err.message; }
  button.disabled = false;
});
