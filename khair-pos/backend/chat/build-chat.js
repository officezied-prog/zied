/* node build-chat.js process  -> the Process Chat code (= chat-core.js + process-chat.js), pasted-free (no key).
   node build-chat.js ops      -> update_workflow operations (JSON) that turn the stub (Chat API -> Respond)
                                  into the full workflow "Khair Mart POS – Chat" (1 webhook + parse + check key +
                                  3 reads + process + respond + 2 write branches). Data tables are POS tables.
   The store key lives inside "Process Chat" (__STORE_KEY__), swapped for the real key when the owner pastes it —
   exactly like the POS Process node. The owner pastes one node only. */
const fs = require('fs'), path = require('path');
const read = f => fs.readFileSync(path.join(__dirname, f), 'utf8');

const T = {
  users:    ['LwAQpWB7ki4BG1in', 'pos_users'],
  settings: ['kTPG7eywHGpNSFGf', 'pos_settings'],
  chat:     ['n7U5yDEesJVkvH2U', 'pos_chat']
};
const CHAT_COLS = 'channel cid from_user from_name from_role body image created_at deleted:b'.split(' ');
const SET_COLS  = 'skey svalue'.split(' ');

const dt = ([value, name]) => ({ __rl: true, mode: 'id', value, cachedResultName: name });
const col = c => { const [n, t] = c.split(':'); return { id: n, displayName: n, required: false, defaultMatch: false, display: true, type: t === 'b' ? 'boolean' : t === 'n' ? 'number' : 'string', canBeUsedToMatch: true }; };
const upsert = (table, cols) => {
  const schema = cols.map(col), value = {};
  schema.forEach(s => { value[s.id] = '={{ $json.' + s.id + ' }}'; });
  return { operation: 'upsert', dataTableId: dt(T[table]), matchType: 'allConditions',
    filters: { conditions: [{ keyName: 'id', condition: 'eq', keyValue: '={{ $json._id }}' }] },
    columns: { mappingMode: 'defineBelow', value, schema }, options: {} };
};
const opsCode = table => ({ jsCode: `const r = ($('Process Chat').first().json.ops || {})[${JSON.stringify(table)}] || [];\nreturn r.map(function (x) { return { json: x }; });` });

const getNode = (name, table, x, y) => ({ type: 'addNode', node: { name, type: 'n8n-nodes-base.dataTable', typeVersion: 1.1,
  parameters: { operation: 'get', dataTableId: dt(T[table]), returnAll: true }, position: [x, y] } });
const codeNode = (name, jsCode, x, y) => ({ type: 'addNode', node: { name, type: 'n8n-nodes-base.code', typeVersion: 2, parameters: { jsCode }, position: [x, y] } });
const dtNode = (name, parameters, x, y) => ({ type: 'addNode', node: { name, type: 'n8n-nodes-base.dataTable', typeVersion: 1.1, parameters, position: [x, y] } });
const setOnce = (name, extra) => ({ type: 'setNodeSettings', nodeName: name, settings: Object.assign({ executeOnce: true }, extra || {}) });
const link = (source, target, sourceIndex) => Object.assign({ type: 'addConnection', source, target }, sourceIndex ? { sourceIndex } : {});

const processCode = () => read('chat-core.js') + '\n' + read('process-chat.js');

const X = 220;
const ops = [
  { type: 'removeConnection', source: 'Chat API', target: 'Respond' },
  codeNode('Parse Chat', read('parse-chat.js'), X, 300),
  getNode('Get Users', 'users', 3 * X, 300),
  getNode('Get Settings', 'settings', 4 * X, 300),
  getNode('Get Chat', 'chat', 5 * X, 300),
  codeNode('Process Chat', '// paste the output of: node backend/chat/build-chat.js process\nreturn [{ json: { response: { ok: false, error: "SERVER", message: "Belum dipasang" }, ops: {} } }];', 6 * X, 300),
  codeNode('Ops chat', opsCode('chat').jsCode, 6 * X, 480),
  dtNode('Upsert chat', upsert('chat', CHAT_COLS), 7 * X, 480),
  codeNode('Ops settings', opsCode('settings').jsCode, 6 * X, 640),
  dtNode('Upsert settings', upsert('settings', SET_COLS), 7 * X, 640),
  // node settings
  setOnce('Respond'),
  setOnce('Get Users', { alwaysOutputData: true }),
  setOnce('Get Settings', { alwaysOutputData: true }),
  setOnce('Get Chat', { alwaysOutputData: true }),
  setOnce('Process Chat', { alwaysOutputData: true }),
  setOnce('Ops chat'), setOnce('Ops settings'),
  // connections: load chain
  link('Chat API', 'Parse Chat'), link('Parse Chat', 'Get Users'),
  link('Get Users', 'Get Settings'), link('Get Settings', 'Get Chat'), link('Get Chat', 'Process Chat'),
  // respond + two write branches (parallel; Respond does not wait on the writes)
  link('Process Chat', 'Respond'),
  link('Process Chat', 'Ops chat'), link('Ops chat', 'Upsert chat'),
  link('Process Chat', 'Ops settings'), link('Ops settings', 'Upsert settings')
];

const mode = process.argv[2];
if (mode === 'process') process.stdout.write(processCode());
else if (mode === 'ops') process.stdout.write(JSON.stringify(ops));
else console.error('usage: node build-chat.js process|ops');
