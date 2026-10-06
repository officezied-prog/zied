const p = $('Process').first().json;
const resp = JSON.parse(JSON.stringify(p.response));
function outRows(name) {
  try { return $(name).all().map(function (i) { return i.json; }); } catch (e) { return []; }
}
if (resp.ok && resp.customer && (resp.customer.id === null || resp.customer.id === undefined)) {
  const r = outRows('Upsert customers').find(function (x) { return x && x.id && x.name === resp.customer.name; });
  if (r) resp.customer.id = r.id;
}
if (resp.ok && resp.product && (resp.product.id === null || resp.product.id === undefined)) {
  const r = outRows('Upsert products').find(function (x) { return x && x.id && x.name === resp.product.name; });
  if (r) resp.product.id = r.id;
}
if (resp.ok && resp.payment && (resp.payment.id === null || resp.payment.id === undefined)) {
  const r = outRows('Upsert payments').find(function (x) { return x && x.id; });
  if (r) resp.payment.id = r.id;
}
return [{ json: resp }];
