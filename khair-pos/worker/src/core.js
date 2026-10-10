// One request, end to end — the same pipeline the n8n workflow ran, used by both the
// Worker (src/index.js) and the local parity tests so what we test is what deploys:
//   parse → load loaders → runProcess (the n8n logic) → apply upserts → finalize.
import { parseRequest } from './parse.js';
import { loadNodes, makeAccessor, applyOps } from './db.js';
import { finalize } from './finalize.js';
import { runProcess } from './generated/process.gen.js';

export async function handleRequest(adapter, body, headers, STORE_KEY) {
  const req = parseRequest(body, headers);
  const nodes = await loadNodes(adapter, req);
  const $ = makeAccessor(nodes);
  const out = runProcess($, STORE_KEY)[0].json; // { response, ops, action }
  const upserts = await applyOps(adapter, out.ops || {});
  return finalize(out.response, upserts);
}
