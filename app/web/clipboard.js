export function clipboardText(signal) {
  return new Promise((resolve, reject) => {
    const request = crypto.randomUUID();
    const cleanup = () => {
      clearTimeout(timer);
      window.removeEventListener('native-clipboard', received);
      signal.removeEventListener('abort', aborted);
    };
    const aborted = () => { cleanup(); reject(new Error('Clipboard transfer cancelled.')); };
    const received = event => {
      if (event.detail?.request !== request) return;
      cleanup();
      if (typeof event.detail.text === 'string') resolve(event.detail.text);
      else reject(new Error(event.detail.error || 'Clipboard unavailable.'));
    };
    const timer = setTimeout(() => { cleanup(); reject(new Error('Clipboard request timed out.')); }, 5000);
    window.addEventListener('native-clipboard', received);
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) { aborted(); return; }
    window.webkit.messageHandlers.native.postMessage(JSON.stringify({ type: 'clipboard', request }));
  });
}
