// Port of the live n8n "Finalize" code node. After the upserts run, new rows have real ids;
// this fills them into the response for the three entities the apps need back immediately
// (a freshly created customer / product / payment). `upserts` maps an ops key to the rows
// that were written by that table's Upsert (each with its id + columns), exactly what the
// live "Upsert X" node outputs.
export function finalize(response, upserts) {
  const resp = JSON.parse(JSON.stringify(response));
  const rowsOf = (key) => (upserts && upserts[key]) || [];
  if (resp.ok && resp.customer && (resp.customer.id === null || resp.customer.id === undefined)) {
    const r = rowsOf('customers').find((x) => x && x.id && x.name === resp.customer.name);
    if (r) resp.customer.id = r.id;
  }
  if (resp.ok && resp.product && (resp.product.id === null || resp.product.id === undefined)) {
    const r = rowsOf('products').find((x) => x && x.id && x.name === resp.product.name);
    if (r) resp.product.id = r.id;
  }
  if (resp.ok && resp.payment && (resp.payment.id === null || resp.payment.id === undefined)) {
    const r = rowsOf('payments').find((x) => x && x.id);
    if (r) resp.payment.id = r.id;
  }
  return resp;
}
