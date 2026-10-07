// Code node "Check Key" — the only node that holds the store key. The owner pastes it with the real key in place of
// __STORE_KEY__ (it is never committed). It only answers whether the key in the request is right.
const STORE_KEY = '__STORE_KEY__';
return [{ json: { key_ok: !/^__.*__$/.test(STORE_KEY) && $('Parse Cold').first().json.key === STORE_KEY } }]; // the placeholder never opens
