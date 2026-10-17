import { createChat } from './shared/chat.js';
import { api, native } from './api.js';
const id = new URLSearchParams(location.search).get('id');
document.getElementById('overview').onclick = () => native({ type: 'overview' });
createChat({ root: document.body, api, apiBase: 'api/chats', initialChat: { id, agentId: id, title: 'Chat' },
  onTitle(title) { document.getElementById('heading').textContent = title; document.title = `Chat · ${title}`; },
  openLink: url => native({ type: 'link', url })
});
