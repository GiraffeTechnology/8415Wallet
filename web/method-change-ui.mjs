/** Private account-management verification. Secrets never leave this UI and the same-origin auth service. */
import { msg, paint } from './i18n.mjs';
import { WalletLoginError } from './login-core.mjs';
let active = null;
const refused = code => new WalletLoginError(code);
const token = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
function node(tag, key, parent) {
  const element = document.createElement(tag); if (key) paint(element, msg(key)); if (parent) parent.append(element); return element;
}
function input(parent, key, type = 'password') {
  const label = node('label', null, parent); node('span', key, label); const value = node('input', null, label);
  value.type = type; value.autocomplete = type === 'password' ? 'off' : 'one-time-code'; value.maxLength = 1024; return value;
}
function current(flow) {
  if (active !== flow || flow.cancelled || !flow.isCurrent()) throw refused('LOGIN_CANCELLED');
  if (flow.expiresAt && Date.now() >= flow.expiresAt) throw refused('AUTH_SETUP_EXPIRED');
}
function prompt(flow, { kind, emailMasked, state }) {
  current(flow);
  return new Promise((resolve, reject) => {
    const priorFocus = document.activeElement, dialog = node('dialog'); dialog.className = 'auth-change-dialog';
    dialog.setAttribute('aria-labelledby', 'auth-change-title');
    const form = node('form', null, dialog); form.method = 'dialog';
    const title = node('h3', `change.${flow.intent.action}`, form); title.id = 'auth-change-title';
    const help = node('p', 'change.combined', form); help.id = 'auth-change-help';
    dialog.setAttribute('aria-describedby', help.id);
    const privateFields = [], controls = {};
    if (kind === 'identity') {
      const label = node('label', null, form); node('span', 'change.identityMethod', label);
      controls.method = node('select', null, label);
      for (const method of ['password', 'wallet']) {
        if (method === 'password' && !state.methods.password.bound || method === 'wallet' && !state.methods.wallet.enabled) continue;
        const option = node('option', `change.${method}`, controls.method); option.value = method;
      }
      controls.password = input(form, 'change.originalPassword'); privateFields.push(controls.password);
      const renderMethod = () => { controls.password.parentElement.hidden = controls.method.value !== 'password'; controls.password.value = ''; };
      controls.method.addEventListener('change', renderMethod); renderMethod();
      if (state.authenticator.enrolled) {
        controls.existingCode = input(form, 'change.existingCode'); privateFields.push(controls.existingCode);
        const label = node('label', null, form); controls.recovery = node('input', null, label); controls.recovery.type = 'checkbox'; node('span', 'change.recoveryCode', label);
      }
      if (state.recovery.configured) { node('p', `recovery.question.${state.recovery.questionId}`, form); controls.answer = input(form, 'change.existingAnswer'); privateFields.push(controls.answer); }
      if (flow.intent.email) paint(node('p', null, form), msg('change.emailTarget', { email: flow.intent.email }));
      if (flow.intent.enabledMethods) paint(node('p', null, form), msg('change.enabledMethods', { methods: flow.intent.enabledMethods.join(', ') }));
    } else {
      paint(node('p', null, form), msg(kind === 'newEmail' ? 'change.newEmail' : 'change.emailSent', { email: emailMasked }));
      controls.code = input(form, 'change.emailCode', 'text'); controls.code.inputMode = 'numeric'; controls.code.maxLength = 8;
      controls.code.pattern = '[0-9]{8}'; controls.code.required = true; privateFields.push(controls.code);
    }
    const actions = node('div', null, form); actions.className = 'actions';
    const submit = node('button', 'change.continue', actions); submit.type = 'submit';
    const cancel = node('button', 'change.cancel', actions); cancel.type = 'button';
    let settled = false, timeout;
    const finish = (value, error) => {
      if (settled) return; settled = true; clearTimeout(timeout); flow.dismiss = null;
      for (const field of privateFields) field.value = '';
      dialog.close(); dialog.remove(); priorFocus?.focus?.();
      if (error) reject(error); else resolve(value);
    };
    flow.dismiss = () => finish(null, refused('LOGIN_CANCELLED'));
    cancel.addEventListener('click', flow.dismiss);
    dialog.addEventListener('cancel', event => { event.preventDefault(); flow.dismiss?.(); });
    dialog.addEventListener('close', () => { if (!settled) flow.dismiss?.(); });
    form.addEventListener('submit', event => {
      event.preventDefault();
      try { current(flow); } catch (error) { finish(null, error); return; }
      if (kind !== 'identity') { if (!/^\d{8}$/.test(controls.code.value)) return; finish({ code: controls.code.value }); return; }
      const value = { identityMethod: controls.method.value };
      if (value.identityMethod === 'password') value.originalPassword = controls.password.value;
      if (controls.existingCode) { value.existingCode = controls.existingCode.value; value.recovery = controls.recovery.checked === true; }
      if (controls.answer) value.existingAnswer = controls.answer.value;
      finish(value);
    });
    document.body.append(dialog); dialog.showModal(); (kind === 'identity' ? controls.method : controls.code).focus();
    timeout = setTimeout(() => finish(null, refused('AUTH_SETUP_EXPIRED')), Math.max(0, (flow.expiresAt ?? state.management.reauthenticateBy) - Date.now()));
  });
}
export function cancelMethodChangeUi() {
  const flow = active; if (!flow) return; active = null; flow.cancelled = true; flow.dismiss?.();
  void flow.client.change('cancel', flow.changeId ? { changeId: flow.changeId } : flow.proof ? { changeProof: flow.proof } : {}).catch(() => {});
}
/** Returns only a proof scoped to the prepared change. TOTP seed is displayed by the management page. */
export async function authorizeMethodChange({ client, intent, state, provider, isCurrent }) {
  cancelMethodChangeUi(); const flow = { client, intent, isCurrent, cancelled: false, expiresAt: state.management.reauthenticateBy }; active = flow;
  let identity;
  try {
    identity = await prompt(flow, { kind: 'identity', state }); current(flow);
    const start = await client.change('start', { ...intent, identityMethod: identity.identityMethod }); intent.newPassword = ''; intent.answer = '';
    flow.changeId = start.changeId;
    if (active !== flow || flow.cancelled) { void client.change('cancel', { changeId: start.changeId }).catch(() => {}); throw refused('LOGIN_CANCELLED'); }
    current(flow);
    if (!token(start.changeId) || start.action !== intent.action || start.origin !== state.origin || start.tenant !== state.tenant ||
      start.account !== state.account || start.chainId !== state.chainId || start.factor !== identity.identityMethod ||
      !Number.isSafeInteger(start.expiresAt) || start.expiresAt > flow.expiresAt || typeof start.emailMasked !== 'string') throw refused('LOGIN_CHALLENGE_BINDING_REFUSED');
    flow.expiresAt = start.expiresAt;
    delete identity.identityMethod;
    if (start.factor === 'wallet') {
      if (typeof start.message !== 'string' || !start.message.includes(`Purpose: ${intent.action}; no login or transaction authority`) ||
        !start.message.includes(`Origin: ${state.origin}`) || !start.message.includes(`Account: ${state.account}`)) throw refused('LOGIN_CHALLENGE_BINDING_REFUSED');
      const encoded = `0x${Array.from(new TextEncoder().encode(start.message), b => b.toString(16).padStart(2, '0')).join('')}`;
      identity.signature = await provider.request({ method: 'personal_sign', params: [encoded, state.account] }); current(flow);
    }
    const sent = await client.change('verify', { changeId: start.changeId, ...identity }); current(flow);
    for (const key of Object.keys(identity)) identity[key] = '';
    if (sent.changeId !== start.changeId || sent.digits !== 8 || sent.emailMasked !== start.emailMasked || sent.expiresAt !== start.expiresAt) throw refused('LOGIN_SERVER_RESPONSE_REFUSED');
    const email = await prompt(flow, { kind: 'email', emailMasked: sent.emailMasked, state }); current(flow);
    let result;
    try { result = await client.change('confirm', { changeId: start.changeId, code: email.code }); } finally { email.code = ''; }
    current(flow);
    if (!token(result.changeProof) || result.action !== intent.action || !Number.isSafeInteger(result.expiresAt) || result.expiresAt > flow.expiresAt ||
      typeof result.newEmailRequired !== 'boolean') throw refused('LOGIN_SERVER_RESPONSE_REFUSED');
    if (intent.action === 'totp.initial' || intent.action === 'totp.replace') {
      if (typeof result.secret !== 'string' || !/^[A-Z2-7]{32}$/.test(result.secret) || typeof result.uri !== 'string' || !result.uri.startsWith('otpauth://totp/')) throw refused('LOGIN_SERVER_RESPONSE_REFUSED');
    }
    active = null; return result;
  } catch (error) { if (active === flow) cancelMethodChangeUi(); throw error; }
  finally { intent.newPassword = ''; intent.answer = ''; if (identity) for (const key of Object.keys(identity)) identity[key] = ''; }
}
export async function commitMethodChange({ client, proof, state, isCurrent, code }) {
  const flow = { client, intent: { action: proof.action }, proof: proof.changeProof, isCurrent, cancelled: false, expiresAt: proof.expiresAt }; active = flow;
  let email;
  try {
    current(flow); if (proof.newEmailRequired) email = await prompt(flow, { kind: 'newEmail', emailMasked: proof.emailMasked, state });
    current(flow);
    const result = await client.change('commit', { changeProof: proof.changeProof, ...(code === undefined ? {} : { code }), ...(email ? { newEmailCode: email.code } : {}) });
    // The service revokes sessions on success; do not try to authenticate again here.
    if (active !== flow || flow.cancelled || !isCurrent()) throw refused('LOGIN_CANCELLED');
    if (result.updated !== true || result.loggedOut !== true || result.action !== proof.action) throw refused('LOGIN_SERVER_RESPONSE_REFUSED');
    active = null; return result;
  } catch (error) { if (active === flow) { active = null; flow.dismiss?.(); } throw error; }
  finally { if (email) email.code = ''; }
}
