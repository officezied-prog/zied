// node build-workflow.js nodes|links|process — the n8n workflow "Khair Gudang Dingin" (1QRX6A1FU0PqRtTP, POST /webhook/khair-cold)
// as update_workflow operations (nodes, then links), and the Process Cold code (= cold-parsers.js + cold-core.js + process-cold.js).
// Check Key and Process Cold are pasted by the owner: Check Key = check-key.js with his key; Process Cold = `node build-workflow.js process`.
const fs = require('fs'), path = require('path');
const read = f => fs.readFileSync(path.join(__dirname, f), 'utf8');
const T = {
  warehouses: ['SrfURGh9rMlha9nS', 'code name address pic_name pic_wa customer_id rate:n rate_unit parser active:b created_at created_by'],
  products: ['km5ciaJdz6EuMHYe', 'code name kg_per_ctn:n aliases active:b created_at created_by'],
  containers: ['HQOIBXsGqHwtCYAq', 'container_no size arrival_date supplier warehouse note created_at created_by'],
  pallets: ['v1KdfKzeAAnCdB3a', 'pallet_code product lot prod_date exp_date kg_per_ctn:n position zone container_no date_in ext_item warehouse created_at created_by'],
  movements: ['ISUlFiRCK23qxeXb', 'seq:n move_date at type pallet_code warehouse cartons:n ref_seq:n grp:n order_no reason by_user'],
  checks: ['EBLmSmYfQxa6RWal', 'check_no check_date warehouse at by_user raw_text result n_diff:n explained_note explained_by explained_at'],
  orders: ['0RJnYBuA7IJe3L5h', 'order_no order_date warehouse dest_type dest_name dest_address pickup_person vehicle note lines status created_at created_by picked_at picked_by pick_date cancel_reason cancelled_at cancelled_by trip'],
  settings: ['kTPG7eywHGpNSFGf', 'skey svalue']
};
const processCode = () => [read('cold-parsers.js'), read('cold-core.js'), read('process-cold.js')].join('\n');
const cap = s => s[0].toUpperCase() + s.slice(1);
const dt = (id, name) => ({ __rl: true, mode: 'id', value: id, cachedResultName: name });
const nodes = [], settings = [], links = [];
let x = 1;
const add = (name, type, v, parameters, set, y) => { nodes.push({ type: 'addNode', node: { name, type, typeVersion: v, position: [x++ * 224, y || 80], parameters } }); if (set) settings.push({ type: 'setNodeSettings', nodeName: name, settings: set }); };
const link = (a, b, i) => links.push(Object.assign({ type: 'addConnection', source: a, target: b }, i ? { sourceIndex: i } : {}));
const GET = { executeOnce: true, alwaysOutputData: true };
add('Parse Cold', 'n8n-nodes-base.code', 2, { jsCode: read('parse-cold.js') });
add('Check Key', 'n8n-nodes-base.code', 2, { jsCode: '// paste backend/cold/check-key.js here with the store key\nreturn [{ json: { key_ok: false } }];' });
add('Get Users', 'n8n-nodes-base.dataTable', 1.1, { resource: 'row', operation: 'get', dataTableId: dt('LwAQpWB7ki4BG1in', 'pos_users'), returnAll: true }, GET);
add('Get Settings', 'n8n-nodes-base.dataTable', 1.1, { resource: 'row', operation: 'get', dataTableId: dt(T.settings[0], 'pos_settings'), returnAll: true }, GET);
const tables = Object.keys(T).filter(t => t !== 'settings');
tables.forEach(t => add('Get ' + cap(t), 'n8n-nodes-base.dataTable', 1.1, Object.assign({ resource: 'row', operation: 'get', dataTableId: dt(T[t][0], 'cold_' + t), returnAll: true },
  t === 'checks' ? { matchType: 'allConditions', filters: { conditions: [{ keyName: 'check_date', condition: 'gte', keyValue: "={{ $('Parse Cold').first().json.checks_from }}" }] } } : {}), GET));
add('Process Cold', 'n8n-nodes-base.code', 2, { jsCode: '// paste the output of: node backend/cold/build-workflow.js process\nreturn [{ json: { response: { ok: false, error: "SERVER", message: "Belum dipasang" }, ops: {} } }];' });
['Cold API', 'Parse Cold', 'Check Key', 'Get Users', 'Get Settings'].concat(tables.map(t => 'Get ' + cap(t))).concat(['Process Cold']).reduce((a, b) => { link(a, b); return b; });
const writes = tables.concat(['settings']);
link('Process Cold', 'Ops ' + writes[0]);
writes.forEach((t, i) => {
  const cols = T[t][1].split(' ').map(c => { const [n, ty] = c.split(':'); return { n, ty: ty === 'n' ? 'number' : ty === 'b' ? 'boolean' : 'string' }; });
  const value = {}; cols.forEach(c => { value[c.n] = '={{ $json.' + c.n + ' }}'; });
  add('Ops ' + t, 'n8n-nodes-base.code', 2, { jsCode: `const r = ($('Process Cold').first().json.ops || {})[${JSON.stringify(t)}] || [];\nreturn r.length ? r.map(function (x) { return { json: x }; }) : [{ json: { _skip: true } }];` }, { executeOnce: true });
  add('Has ' + t, 'n8n-nodes-base.if', 2.3, { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 }, combinator: 'and',
    conditions: [{ leftValue: '={{ $json._skip === true }}', rightValue: '', operator: { type: 'boolean', operation: 'false', singleValue: true } }] } });
  add('Upsert ' + t, 'n8n-nodes-base.dataTable', 1.1, { resource: 'row', operation: 'upsert', dataTableId: dt(T[t][0], t === 'settings' ? 'pos_settings' : 'cold_' + t), matchType: 'allConditions',
    filters: { conditions: [{ keyName: 'id', condition: 'eq', keyValue: '={{ $json._id }}' }] },
    columns: { mappingMode: 'defineBelow', value, schema: cols.map(c => ({ id: c.n, displayName: c.n, required: false, defaultMatch: false, display: true, type: c.ty, canBeUsedToMatch: true })) } }, null, -80);
  const next = i + 1 < writes.length ? 'Ops ' + writes[i + 1] : 'Respond';
  link('Ops ' + t, 'Has ' + t); link('Has ' + t, 'Upsert ' + t); link('Upsert ' + t, next); link('Has ' + t, next, 1);
});
const mode = process.argv[2];
if (mode === 'process') process.stdout.write(processCode());
else if (mode === 'nodes') process.stdout.write(JSON.stringify(nodes.concat(settings)));
else if (mode === 'links') process.stdout.write(JSON.stringify([{ type: 'removeConnection', source: 'Cold API', target: 'Respond' }].concat(links)));
else console.error('usage: node build-workflow.js nodes|links|process');
