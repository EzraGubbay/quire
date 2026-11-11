// The sign-in helper: a small frameless panel docked to the Lemida login window that offers one-click fill of
// the stored username / password / TOTP code. It is a child of the login window (opens with it, closes with
// it) so our trusted UI and preload stay isolated from Microsoft's CSP-restricted login page — nothing is
// injected into that page except the field value at the moment the user asks to fill it.
//
// The actual fill runs here in main (`fillStep`): it finds the relevant field on the login webContents and
// sets its value with a React-compatible setter. The password and TOTP secret never enter a renderer; only the
// derived 6-digit code is shown in the panel.
import path from 'node:path';
import { BrowserWindow, type WebContents } from 'electron';
import * as creds from './credentials';

const HELPER_WIDTH = 288;
const HELPER_HEIGHT = 196;
const MARGIN = 14;

// The one login window a fill targets. Set while a sign-in is open, cleared when the helper closes, so a stray
// `lemida-fill` IPC can never inject into an unrelated page.
let activeLoginWC: WebContents | null = null;
let helper: BrowserWindow | null = null;

export type FillField = 'auto' | 'username' | 'password' | 'totp';

// Microsoft's login field names are stable across its flow; the fallbacks cover theme/DOM variation. Ordered
// so the most specific selector wins.
const SELECTORS: Record<'username' | 'password' | 'totp', string[]> = {
  username: ['input[name="loginfmt"]', 'input[type="email"]', 'input[name="UserName"]'],
  password: ['input[name="passwd"]', 'input[type="password"]:not([aria-hidden="true"])'],
  totp: ['input[name="otc"]', 'input[autocomplete="one-time-code"]', 'input[inputmode="numeric"]'],
};

function placeHelper(parent: BrowserWindow): void {
  if (!helper || helper.isDestroyed() || parent.isDestroyed()) return;
  const b = parent.getBounds();
  helper.setBounds({
    x: b.x + b.width - HELPER_WIDTH - MARGIN,
    y: b.y + MARGIN,
    width: HELPER_WIDTH,
    height: HELPER_HEIGHT,
  });
}

/** Open the helper panel docked to `parent` and point fills at `loginWC`. Idempotent per sign-in. */
export function openHelper(parent: BrowserWindow, loginWC: WebContents): void {
  activeLoginWC = loginWC;
  helper = new BrowserWindow({
    width: HELPER_WIDTH,
    height: HELPER_HEIGHT,
    parent,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    show: false,
    skipTaskbar: true,
    title: 'Lemida sign-in helper',
    webPreferences: {
      preload: path.join(__dirname, '../ui/bar-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  helper.loadFile(path.join(__dirname, '../ui/bar.html')).catch(() => {});
  helper.once('ready-to-show', () => {
    placeHelper(parent);
    helper?.showInactive(); // don't steal focus from the login form
  });
  const reposition = () => placeHelper(parent);
  parent.on('move', reposition);
  parent.on('resize', reposition);
  parent.once('closed', () => closeHelper());
  helper.on('closed', () => {
    helper = null;
  });
}

/** Tear the helper down and stop targeting any login window. Safe to call more than once. */
export function closeHelper(): void {
  activeLoginWC = null;
  if (helper && !helper.isDestroyed()) helper.destroy();
  helper = null;
}

/** Which step the login page is currently showing, by the first visible field group. */
async function detectStep(wc: WebContents): Promise<'username' | 'password' | 'totp' | null> {
  const script = `(() => {
    const visible = (sel) => Array.from(document.querySelectorAll(sel))
      .some((el) => el.offsetParent !== null && !el.disabled);
    const groups = ${JSON.stringify(SELECTORS)};
    for (const key of ['totp', 'password', 'username']) {
      if (groups[key].some(visible)) return key;
    }
    return null;
  })()`;
  try {
    return (await wc.executeJavaScript(script, true)) as 'username' | 'password' | 'totp' | null;
  } catch {
    return null;
  }
}

// Set a field's value the way React expects: the native value setter plus dispatched input/change events, so
// Microsoft's framework registers the change (a bare `el.value = x` would be ignored by its onChange).
function fillScript(selectors: string[], value: string): string {
  const sels = JSON.stringify(selectors);
  const val = JSON.stringify(value);
  return `(() => {
    const sels = ${sels};
    let el = null;
    for (const s of sels) {
      el = Array.from(document.querySelectorAll(s)).find((e) => e.offsetParent !== null && !e.disabled);
      if (el) break;
    }
    if (!el) return false;
    el.focus();
    const desc = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
    if (desc && desc.set) desc.set.call(el, ${val}); else el.value = ${val};
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`;
}

/** Fill one field on the active login window from the vault. `auto` fills whichever step is on screen. */
export async function fillStep(field: FillField): Promise<{ filled: boolean; step?: string }> {
  const wc = activeLoginWC;
  if (!wc || wc.isDestroyed()) return { filled: false };

  let target: 'username' | 'password' | 'totp';
  if (field === 'auto') {
    const step = await detectStep(wc);
    if (!step) return { filled: false };
    target = step;
  } else {
    target = field;
  }

  let value: string | undefined;
  if (target === 'username') value = await creds.getUsername();
  else if (target === 'password') value = await creds.getPassword();
  else value = (await creds.currentCode())?.code;
  if (!value) return { filled: false, step: target };

  try {
    const ok = (await wc.executeJavaScript(fillScript(SELECTORS[target], value), true)) as boolean;
    return { filled: !!ok, step: target };
  } catch {
    return { filled: false, step: target };
  }
}
