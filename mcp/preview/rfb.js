// This transport paints a local capture and has no WebSocket or input channel.
export default class PreviewDesktop extends EventTarget {
  constructor(target) {
    super();
    this.target = target;
    this.wrapper = document.createElement('div');
    this.wrapper.style.cssText = 'display:flex;width:100%;height:100%;overflow:hidden;align-items:center;justify-content:center;';
    this.canvas = document.createElement('canvas');
    this.canvas.setAttribute('aria-label', 'Preview desktop capture, input disabled');
    this.wrapper.append(this.canvas); target.append(this.wrapper);
    this.image = new Image();
    this.image.onload = () => {
      if (this.closed) return;
      this.canvas.width = this.image.naturalWidth; this.canvas.height = this.image.naturalHeight;
      this.resize(); this.paint();
      this.painter = setInterval(() => this.paint(), 250);
      this.dispatchEvent(new Event('connect'));
      this.dispatchEvent(new Event('firstframe'));
    };
    this.image.onerror = () => this.dispatchEvent(new Event('securityfailure'));
    this.image.src = '/sample-desktop.png';
    this.observer = new ResizeObserver(() => this.resize()); this.observer.observe(target);
  }
  set scaleViewport(value) { this.scaled = value; this.resize(); }
  get scaleViewport() { return this.scaled; }
  resize() {
    if (!this.canvas?.width) return;
    const scale = this.scaled ? Math.min(this.target.clientWidth / this.canvas.width, this.target.clientHeight / this.canvas.height) : 1;
    this.canvas.style.width = `${this.canvas.width * scale}px`;
    this.canvas.style.height = `${this.canvas.height * scale}px`;
    this.canvas.style.flexShrink = '0';
  }
  paint() {
    const ctx = this.canvas.getContext('2d');
    ctx.drawImage(this.image, 0, 0);
    ctx.fillStyle = '#121413'; ctx.fillRect(0, 0, this.canvas.width, 32);
    ctx.fillStyle = '#e5efe9'; ctx.font = '18px sans-serif';
    ctx.fillText('PREVIEW · captured image · input disabled', 12, 23);
  }
  sendKey() {}
  disconnect() { this.closed = true; this.observer.disconnect(); clearInterval(this.painter); }
}
