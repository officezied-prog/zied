# Khair Mart POS — project notes

Self-contained HTML PWAs under `khair-pos/` (owner `index.html`, cashier `kasir/`,
field-sales `sales/`, cold-storage `gudang/`), served via GitHub Pages from `main`.
Backend today is n8n Cloud (ziedapp.app.n8n.cloud) — logic lives in the "Process" Code
node, mirrored by `khair-pos/backend/*`. Tests: Playwright under `khair-pos/tests*`.

## Owner standing rules — ALWAYS honor

- **Cost first (recommend best + cheapest, proactively).** The owner (Khair Mart,
  Jakarta) is cost-conscious. For EVERY technical choice, state the **best** AND the
  **cheapest** option together, and clearly flag cost / efficiency trade-offs, BEFORE
  the owner decides — do not wait to be asked. (Owner's standing rule, set 2026-10-10.)

- **Watch execution/running cost.** The POS once hit the n8n Starter plan's monthly
  execution limit because the apps polled too often. Keep backend calls lean (polls are
  throttled and pause when the tab is hidden; device ping is hourly). When adding
  features, consider their recurring-cost impact and mention it.

- **Mixed Arabic/English text:** when writing Arabic and a word/term is English, put each
  English token on its own line, then continue the Arabic on a new line (keeps the
  right-to-left reading order clean).
