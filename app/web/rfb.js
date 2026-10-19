import RFB from './novnc/core/rfb.js';
import { encodings as e } from './novnc/core/encodings.js';

// noVNC 1.7.0 has no public lossless or first-painted-frame API. Keep the
// protocol adaptation here; test negotiation and painted pixels when upgrading.
export default class DesktopRFB extends RFB {
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
}
