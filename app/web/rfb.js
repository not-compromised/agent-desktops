import RFB from './novnc/core/rfb.js';
import { encodings as e } from './novnc/core/encodings.js';
import KeyTable from './novnc/core/input/keysym.js';

const NUMPAD_CHARACTERS = new Set([...Array(10).keys()].map(n => KeyTable.XK_KP_0 + n)
  .concat(KeyTable.XK_KP_Decimal, KeyTable.XK_KP_Separator));
const isNumpadNavigation = keysym => keysym >= KeyTable.XK_KP_Home && keysym <= KeyTable.XK_KP_Delete;
const PLAIN_NUMPAD = new Map([...Array(10).keys()].map(n => [KeyTable.XK_KP_0 + n, KeyTable.XK_0 + n])
  .concat([[KeyTable.XK_KP_Decimal, KeyTable.XK_period], [KeyTable.XK_KP_Separator, KeyTable.XK_comma]]));
export const numLockFromKey = (keysym, shifted) => shifted ? null : NUMPAD_CHARACTERS.has(keysym) ? true : isNumpadNavigation(keysym) ? false : null;

const CLIPBOARD_TEXT = 1, CLIPBOARD_PROVIDE = 1 << 28;

const anyHeld = (held, ...codes) => codes.some(code => held.has(code));
export function isPasteChord(keysym, held) {
  if (anyHeld(held, 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight')) return false;
  const control = anyHeld(held, 'ControlLeft', 'ControlRight');
  if (control) return keysym === KeyTable.XK_v || keysym === KeyTable.XK_V;
  return keysym === KeyTable.XK_Insert && anyHeld(held, 'ShiftLeft', 'ShiftRight');
}

export default class DesktopRFB extends RFB {
  readClipboard = null;
  _keysHeld = new Map();
  _paste = null;
  _deliveredText = null;
  get viewOnly() { return super.viewOnly; }
  set viewOnly(value) {
    if (value) this._releaseKeys();
    super.viewOnly = value;
  }
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
    const key = { keysym, code, down, capsLock };
    if (this._paste) { this._paste.queue.push(key); return; }
    if (down && this.readClipboard && isPasteChord(keysym, this._keysHeld)) {
      this._paste = { queue: [key], cancelled: false };
      void this._pasteThenType(this._paste);
      return;
    }
    this._forwardKey(key);
  }
  _forwardKey({ keysym, code, down, capsLock }) {
    const numLock = numLockFromKey(keysym, anyHeld(this._keysHeld, 'ShiftLeft', 'ShiftRight'));
    if (down) this._keysHeld.set(code, keysym);
    else if (!this._keysHeld.delete(code)) return;
    if (!this._qemuExtKeyEventSupported) keysym = PLAIN_NUMPAD.get(keysym) ?? keysym;
    super._handleKeyEvent(keysym, code, down, numLock, capsLock);
  }
  _releaseKeys() {
    if (this._paste) { this._paste.cancelled = true; this._paste = null; }
    for (const [code, keysym] of this._keysHeld) this._forwardKey({ keysym, code, down: false, capsLock: null });
  }
  async _pasteThenType(paste) {
    const text = await this.readClipboard();
    if (paste.cancelled) return;
    if (text === null) this._deliveredText = null;
    if (typeof text === 'string' && text !== this._deliveredText) this._handOverClipboard(text);
    this._paste = null;
    for (const key of paste.queue) this._forwardKey(key);
  }
  _handOverClipboard(text) {
    if (this._rfbConnectionState !== 'connected' || this._viewOnly) return;
    this._deliveredText = text;
    if (!this._clipboardServerCapabilitiesFormats[CLIPBOARD_TEXT] || !this._clipboardServerCapabilitiesActions[CLIPBOARD_PROVIDE]) {
      RFB.messages.clientCutText(this._sock, Uint8Array.from(text, c => c.codePointAt(0) > 0xff ? 0x3f : c.codePointAt(0)));
      return;
    }
    this._clipboardText = text;
    RFB.messages.extendedClipboardProvide(this._sock, [CLIPBOARD_TEXT], [text]);
  }
}
