import RFB from './novnc/core/rfb.js';
import { encodings as e } from './novnc/core/encodings.js';
import KeyTable from './novnc/core/input/keysym.js';

const NUMPAD_CHARACTERS = new Set([...Array(10).keys()].map(n => KeyTable.XK_KP_0 + n)
  .concat(KeyTable.XK_KP_Decimal, KeyTable.XK_KP_Separator));
const isNumpadNavigation = keysym => keysym >= KeyTable.XK_KP_Home && keysym <= KeyTable.XK_KP_Delete;
export const numLockFromKey = keysym => NUMPAD_CHARACTERS.has(keysym) ? true : isNumpadNavigation(keysym) ? false : null;

const CLIPBOARD_TEXT = 1, CLIPBOARD_REQUEST = 1 << 25, CLIPBOARD_NOTIFY = 1 << 27;
export const CLIPBOARD_HANDOFF_MS = 1000;

const anyHeld = (held, ...codes) => codes.some(code => held.has(code));
export function isPasteChord(keysym, held) {
  if (anyHeld(held, 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight')) return false;
  const control = anyHeld(held, 'ControlLeft', 'ControlRight');
  if (control) return keysym === KeyTable.XK_v || keysym === KeyTable.XK_V;
  return keysym === KeyTable.XK_Insert && anyHeld(held, 'ShiftLeft', 'ShiftRight');
}

export default class DesktopRFB extends RFB {
  readClipboard = null;
  _keysHeld = new Set();
  _pasteQueue = null;
  _clipboardRequested = null;
  get lossless() { return Boolean(this._lossless); }
  set lossless(value) {
    if (Boolean(value) === this.lossless) return;
    this._lossless = Boolean(value);
    if (this._rfbConnectionState === 'connected') {
      this._sendEncodings();
      RFB.messages.fbUpdateRequest(this._sock, false, 0, 0, this._fbWidth, this._fbHeight);
    }
  }
  _sendEncodings() {
    if (!this.lossless) return super._sendEncodings();
    const encs = [e.encodingCopyRect];
    if (this._fbDepth === 24) encs.push(e.encodingTight, e.encodingTightPNG, e.encodingZRLE,
      e.encodingHextile, e.encodingRRE, e.encodingZlib);
    encs.push(e.encodingRaw, e.pseudoEncodingCompressLevel0 + this._compressionLevel,
      e.pseudoEncodingDesktopSize, e.pseudoEncodingLastRect, e.pseudoEncodingQEMUExtendedKeyEvent,
      e.pseudoEncodingQEMULedEvent, e.pseudoEncodingExtendedDesktopSize, e.pseudoEncodingXvp,
      e.pseudoEncodingFence, e.pseudoEncodingContinuousUpdates, e.pseudoEncodingDesktopName,
      e.pseudoEncodingExtendedClipboard, e.pseudoEncodingExtendedMouseButtons);
    if (this._fbDepth === 24) encs.push(e.pseudoEncodingVMwareCursor, e.pseudoEncodingCursor);
    RFB.messages.clientEncodings(this._sock, encs);
  }
  _handleDataRect() {
    const complete = super._handleDataRect();
    if (complete) this._receivedPixels = true;
    return complete;
  }
  _framebufferUpdate() {
    const complete = super._framebufferUpdate();
    if (complete && this._receivedPixels && !this._firstFrame) {
      this._firstFrame = true;
      this._display.flush().then(() => {
        if (this._rfbConnectionState === 'connected') this.dispatchEvent(new Event('firstframe'));
      });
    }
    return complete;
  }
  _handleKeyEvent(keysym, code, down, _browserNumLock, capsLock) {
    const key = { keysym, code, down, numLock: numLockFromKey(keysym), capsLock };
    if (this._pasteQueue) { this._pasteQueue.push(key); return; }
    if (down && this.readClipboard && isPasteChord(keysym, this._keysHeld)) {
      this._pasteQueue = [key];
      void this._pasteThenType();
      return;
    }
    this._forwardKey(key);
  }
  _forwardKey({ keysym, code, down, numLock, capsLock }) {
    if (down) this._keysHeld.add(code); else this._keysHeld.delete(code);
    super._handleKeyEvent(keysym, code, down, numLock, capsLock);
  }
  async _pasteThenType() {
    try {
      const text = await this.readClipboard();
      if (typeof text === 'string') await this._handOverClipboard(text);
    } finally {
      const queue = this._pasteQueue;
      this._pasteQueue = null;
      for (const key of queue) this._forwardKey(key);
    }
  }
  _handOverClipboard(text) {
    const announcedOnly = this._clipboardServerCapabilitiesFormats[CLIPBOARD_TEXT] && this._clipboardServerCapabilitiesActions[CLIPBOARD_NOTIFY];
    this.clipboardPasteFrom(text);
    if (!announcedOnly) return Promise.resolve();
    return new Promise(resolve => {
      const done = () => { clearTimeout(timer); if (this._clipboardRequested === done) this._clipboardRequested = null; resolve(); };
      const timer = setTimeout(done, CLIPBOARD_HANDOFF_MS);
      this._clipboardRequested = done;
    });
  }
  _handleServerCutText() {
    const header = this._sock.rQlen() >= 11 ? new DataView(this._sock.rQpeekBytes(11).buffer) : null;
    const handled = super._handleServerCutText();
    if (handled && header && header.getInt32(3) < 0 && (header.getUint32(7) & 0xff000000) === CLIPBOARD_REQUEST) this._clipboardRequested?.();
    return handled;
  }
}
