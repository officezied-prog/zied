# Khair Mart POS — project notes

Self-contained HTML PWAs under `khair-pos/` (owner `index.html`, cashier `kasir/`,
field-sales `sales/`, cold-storage `gudang/`), served via GitHub Pages from `main`.
Backend today is n8n Cloud (ziedapp.app.n8n.cloud) — logic lives in the "Process" Code
node, mirrored by `khair-pos/backend/*`. Tests: Playwright under `khair-pos/tests*`.

## Owner standing rules — ALWAYS honor

- **Reliability FIRST, then cost (recommend best + cheapest, proactively).** The owner
  (Khair Mart, Jakarta) wants a system that is **strong, stable, and always-on**, that
  does NOT stop and does NOT depend on staff being present — he travels a lot and cannot
  babysit it or rely on employees to keep it running. So the top priority is a solution
  that keeps working on its own. He is still cost-conscious, but cost is the tie-breaker
  AMONG reliable options, not the first filter. For EVERY technical choice, state the
  **most reliable** option AND the **cheapest** option together, flag the trade-offs,
  and recommend BEFORE the owner decides — do not wait to be asked. (Owner's standing
  rules, set 2026-10-10, refined 2026-10-10: reliability over pure cost.)

- **Watch execution/running cost — but never at the expense of uptime.** The POS once
  hit the n8n Starter plan's monthly execution limit because the apps polled too often,
  and that one quota wall took down ALL apps (login failed for everyone) until support
  reset it. That "whole business stops at once, owner must intervene from abroad" failure
  mode is exactly what the owner wants gone. Keep backend calls lean (polls are throttled
  and pause when the tab is hidden; device ping is hourly), and when adding features,
  consider their recurring-cost impact — but prefer architectures with no hard monthly
  cap that can halt everything.

- **Mixed Arabic/English text:** when writing Arabic and a word/term is English, put each
  English token on its own line, then continue the Arabic on a new line (keeps the
  right-to-left reading order clean).
