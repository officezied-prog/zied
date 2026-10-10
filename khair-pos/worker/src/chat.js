// Chat API — replaces the n8n "Khair Mart POS – Chat" workflow (POST .../webhook/khair-chat).
// Loaders are three full tables (users, settings, chat); the process node is chat-core.js +
// process-chat.js (wrapped by build.js); writers upsert pos_chat / pos_settings. No Finalize.
import { execSpecs, makeAccessor, applyOps, Q } from './db.js';
import { OPS_TABLE_CHAT } from '../tables.js';
import { runProcessChat } from './generated/process-chat.gen.js';

// Port of the live "Parse Chat" code node.
export function parseChat(body) {
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  if (!body || typeof body !== 'object') body = {};
  return {
    action: String(body.action || '').slice(0, 40),
    key: String(body.key || ''),
    user: String(body.user || '').slice(0, 60),
    pin_hash: String(body.pin_hash || '').slice(0, 64),
    data: body.data && typeof body.data === 'object' ? body.data : {},
  };
}

export async function loadChatNodes(adapter, req) {
  const nodes = await execSpecs(adapter, {
    'Get Users': Q.all('pos_users'),
    'Get Settings': Q.all('pos_settings'),
    'Get Chat': Q.all('pos_chat'),
  });
  nodes['Parse Chat'] = [req];
  return nodes;
}

export async function handleChat(adapter, body, headers, STORE_KEY) {
  const req = parseChat(body);
  const nodes = await loadChatNodes(adapter, req);
  const $ = makeAccessor(nodes);
  const out = runProcessChat($, STORE_KEY)[0].json; // { response, ops }
  await applyOps(adapter, out.ops || {}, OPS_TABLE_CHAT);
  return out.response;
}
