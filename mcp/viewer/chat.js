import { createChat as sharedChat } from '/shared/chat.js';
import { api } from '/shared/api.js';
export const createChat = options => sharedChat({ ...options, api });
