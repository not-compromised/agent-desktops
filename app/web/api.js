export { api } from './shared/api.js';
export function native(message) {
  if (window.webkit?.messageHandlers?.native) window.webkit.messageHandlers.native.postMessage(JSON.stringify(message));
  else if (message.type === 'overview') location.href = './';
  else if (message.type === 'chat') window.open(`chat.html?id=${encodeURIComponent(message.id)}`, '_blank');
}
