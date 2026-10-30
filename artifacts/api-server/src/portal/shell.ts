// The customer portal's page shell, theme bootstrap and stylesheet, served at
// /portal by routes/portal_pages.ts. The look is the VerifiedSubmission design
// system from the Relay console (apps/console/app/globals.css), so the portal
// matches app.verifiedsubmission.com: Geist on warm off-white, near-black ink,
// lime used sparingly, pill buttons and inputs, soft-cornered cards, light
// headings. Light by default; dark on <html data-theme="dark">.

export const PORTAL_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>VerifiedSubmission Portal</title>
<link rel="icon" href="/portal/brand/mark.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@300..700&family=Geist+Mono:wght@400;500&display=swap">
<link rel="stylesheet" href="/portal/app.css">
<script src="/portal/theme.js"></script>
</head>
<body>
<div id="app"><p class="boot">Loading…</p></div>
<script src="/portal/app.js"></script>
</body>
</html>`;

// Runs in <head>, before first paint, so a saved dark theme never flashes
// light. Same pattern as the console, under the portal's own storage key.
export const PORTAL_THEME_JS = `(function(){var t="light";try{if(localStorage.getItem("vs.portal.theme")==="dark")t="dark"}catch(e){}document.documentElement.setAttribute("data-theme",t)})();`;

export const PORTAL_CSS = `
:root {
  --bg: #fbfaf8; --card: #ffffff; --border: #e8e6df; --divider: #eeece4;
  --text: #1a1a18; --text-mut: #6b6b63;
  --brand: #1a1a18; --brand-ink: #fbfaf8; --brand-soft: rgba(26,26,24,.06);
  --accent: #d8ff3e; --accent-soft: rgba(216,255,62,.22);
  --ok: #2e7d4f; --ok-soft: rgba(46,125,79,.1); --warn: #9a5b0a; --warn-soft: rgba(154,91,10,.1);
  --bad: #a83029; --bad-soft: rgba(168,48,41,.1);
  --hover: #f1efe7; --row-hover: #faf7ee;
  --chart-ok: #2e7d4f; --chart-warn: #d99a2b; --chart-bad: #c2463d;
  --font-sans: "Geist", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  --font-mono: "Geist Mono", ui-monospace, "Cascadia Code", Consolas, monospace;
  --fs-xs: .75rem; --fs-sm: .8125rem; --fs-md: .9375rem; --fs-lg: 1.125rem; --fs-xl: 1.5rem; --fs-2xl: 1.875rem; --fs-kpi: 2.5rem;
  --radius: 14px; --radius-sm: 10px; --radius-xs: 6px; --radius-pill: 999px;
  --ease-out: cubic-bezier(.22,1,.36,1); --t-fast: 140ms;
  color-scheme: light;
}
:root[data-theme="dark"] {
  --bg: #141311; --card: #1c1a16; --border: #2a2822; --divider: #201e19;
  --text: #f0ece2; --text-mut: #9b968a;
  --brand: #d8ff3e; --brand-ink: #1a1a18; --brand-soft: rgba(216,255,62,.12);
  --accent-soft: rgba(216,255,62,.18);
  --ok: #86d7a4; --ok-soft: rgba(134,215,164,.14); --warn: #e9c173; --warn-soft: rgba(233,193,115,.14);
  --bad: #f3a79e; --bad-soft: rgba(243,167,158,.14);
  --hover: #242019; --row-hover: #1a1915;
  --chart-ok: #86d7a4; --chart-warn: #e9c173; --chart-bad: #f3a79e;
  color-scheme: dark;
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body { background: var(--bg); color: var(--text); font-family: var(--font-sans); font-size: var(--fs-md); line-height: 1.5; -webkit-font-smoothing: antialiased; }
button, input { font-family: inherit; font-size: inherit; color: inherit; }
h1, h2, h3 { margin: 0; letter-spacing: -.015em; text-wrap: balance; }
h1 { font-size: var(--fs-2xl); line-height: 1.15; font-weight: 400; letter-spacing: -.02em; }
h2 { font-size: var(--fs-lg); font-weight: 500; }
a { color: var(--brand); text-decoration: none; }
a:hover { text-decoration: underline; }
:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; border-radius: var(--radius-xs); }
.mono { font-family: var(--font-mono); font-size: var(--fs-sm); }
.muted { color: var(--text-mut); }
.small { font-size: var(--fs-sm); }
.boot { padding: 48px; color: var(--text-mut); text-align: center; }

/* Logo: both variants are in the DOM; the theme shows one. */
.brand { display: inline-flex; align-items: center; gap: 12px; white-space: nowrap; }
.brand-logo { display: inline-flex; height: 26px; flex-shrink: 0; }
.brand-logo img { display: block; height: 100%; width: auto; }
.brand-logo .dark { display: none; }
:root[data-theme="dark"] .brand-logo .light { display: none; }
:root[data-theme="dark"] .brand-logo .dark { display: block; }
.product { padding: 4px 10px; border: 1px solid var(--border); border-radius: var(--radius-pill); background: var(--card); font-size: var(--fs-xs); font-weight: 500; color: var(--text-mut); letter-spacing: .04em; text-transform: uppercase; line-height: 1; }

/* Sign-in: the console's connect card */
.auth { min-height: 100vh; display: grid; place-items: center; padding: 24px 16px; }
.auth-card { width: 100%; max-width: 460px; background: var(--card); border: 1px solid var(--border); border-radius: var(--radius); padding: 36px; }
.wordmark { display: flex; align-items: center; gap: 12px; padding-bottom: 20px; }
.wordmark .brand-logo { height: 30px; }
.wordmark small { padding-left: 12px; border-left: 1px solid var(--border); color: var(--text-mut); font-size: var(--fs-md); font-weight: 500; line-height: 1; }
.auth-card h1 { font-size: var(--fs-xl); margin: 4px 0 6px; }
.auth-card p.lead { margin: 0 0 8px; color: var(--text-mut); }
label { display: block; font-size: var(--fs-sm); font-weight: 500; margin: 16px 0 6px; }
input[type=email], input[type=password], input[type=text] {
  width: 100%; padding: 9px 16px; font-size: var(--fs-md); color: var(--text); background: var(--card);
  border: 1px solid var(--border); border-radius: var(--radius-pill); outline: none;
  transition: border-color var(--t-fast) var(--ease-out), box-shadow var(--t-fast) var(--ease-out);
}
input::placeholder { color: var(--text-mut); }
input:focus { border-color: var(--brand); box-shadow: 0 0 0 3px var(--brand-soft); }
.btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; height: 40px; padding: 0 20px; border-radius: var(--radius-pill); border: 1px solid var(--border); background: var(--card); color: var(--text); font-size: var(--fs-md); font-weight: 500; cursor: pointer; white-space: nowrap; text-decoration: none; transition: background var(--t-fast) var(--ease-out), border-color var(--t-fast) var(--ease-out), filter var(--t-fast) var(--ease-out); }
.btn:hover { background: var(--hover); text-decoration: none; }
.btn-primary { background: var(--brand); border-color: var(--brand); color: var(--brand-ink); }
.btn-primary:hover { background: var(--brand); filter: brightness(.92); }
.btn-danger { color: var(--bad); }
.btn-danger:hover { background: var(--bad-soft); border-color: var(--bad); }
.btn-sm { height: 32px; padding: 0 12px; font-size: var(--fs-sm); }
.btn-block { width: 100%; margin-top: 22px; }
.btn[disabled] { opacity: .55; cursor: not-allowed; }
.link-btn { background: none; border: 0; padding: 0; color: var(--text); cursor: pointer; font-size: var(--fs-sm); text-decoration: underline; text-decoration-color: var(--border); text-underline-offset: 3px; }
.link-btn:hover { text-decoration-color: var(--text); }
.alert { padding: 12px 16px; border-radius: var(--radius-sm); margin: 16px 0 0; border: 1px solid transparent; }
.alert-bad { background: var(--bad-soft); color: var(--bad); border-color: var(--bad); }
.alert-ok { background: var(--ok-soft); color: var(--ok); }
.alert-warn { background: var(--warn-soft); color: var(--warn); margin: 0 0 20px; }
.auth-foot { margin-top: 18px; display: flex; justify-content: space-between; align-items: center; }

/* App bar and page tabs */
.appbar { position: sticky; top: 0; z-index: 200; height: 56px; display: flex; align-items: center; gap: 12px; padding: 0 28px; background: var(--bg); border-bottom: 1px solid var(--border); }
.appbar-right { margin-left: auto; display: flex; align-items: center; gap: 8px; font-size: var(--fs-sm); }
.who { color: var(--text-mut); padding: 6px 12px; background: var(--card); border: 1px solid var(--border); border-radius: var(--radius-pill); max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-right: 6px; }
.bar-btn { height: 36px; padding: 0 14px; border-radius: var(--radius-sm); border: 1px solid var(--border); background: var(--card); color: var(--text); font-size: var(--fs-sm); font-weight: 600; cursor: pointer; white-space: nowrap; }
.bar-btn:hover { background: var(--hover); }
.tabs { display: flex; gap: 4px; padding: 0 28px; background: var(--card); border-bottom: 1px solid var(--border); overflow-x: auto; }
.tab { display: inline-flex; align-items: center; padding: 14px 12px; margin-bottom: -1px; border-bottom: 2px solid transparent; color: var(--text-mut); font-weight: 500; white-space: nowrap; }
.tab:hover { color: var(--text); text-decoration: none; }
.tab.active { color: var(--brand); border-bottom-color: var(--brand); font-weight: 600; }
.page { max-width: 1200px; margin: 0 auto; padding: 28px 28px 80px; }
.page-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 24px; margin-bottom: 24px; flex-wrap: wrap; }
.page-head p { margin: 4px 0 0; color: var(--text-mut); }
.seg { display: inline-flex; border: 1px solid var(--border); border-radius: var(--radius-pill); background: var(--card); padding: 3px; gap: 2px; }
.seg button { border: 0; background: transparent; padding: 7px 14px; border-radius: var(--radius-pill); font-size: var(--fs-sm); font-weight: 500; color: var(--text-mut); cursor: pointer; transition: background var(--t-fast) var(--ease-out), color var(--t-fast) var(--ease-out); }
.seg button:hover { color: var(--text); }
.seg button[aria-pressed="true"] { background: var(--brand); color: var(--brand-ink); }

/* Sections are cards; KPI tiles sit in a row above them. */
.card { background: var(--card); border: 1px solid var(--border); border-radius: var(--radius); padding: 20px 24px 24px; }
.card + .card, .grid + .card, .card + .grid, .grid + .grid { margin-top: 24px; }
.card h2 { margin: 0 0 4px; }
.card .sub { margin: 0 0 16px; color: var(--text-mut); font-size: var(--fs-sm); }
.grid { display: grid; gap: 12px; }
.grid > .card { margin-top: 0; }
.kpis { grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); }
.two { grid-template-columns: 3fr 2fr; gap: 24px; }
.kpi { padding: 20px 22px 18px; }
.kpi .label { font-weight: 500; color: var(--text-mut); margin-bottom: 8px; }
.kpi .value { font-size: var(--fs-kpi); line-height: 1.05; font-weight: 450; letter-spacing: -.025em; font-variant-numeric: tabular-nums; }
.kpi .note { font-size: var(--fs-sm); color: var(--text-mut); margin-top: 6px; }
.dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 8px; vertical-align: 1px; }
.dot.ok { background: var(--chart-ok); } .dot.warn { background: var(--chart-warn); } .dot.bad { background: var(--chart-bad); }

.chart { display: flex; align-items: flex-end; gap: 4px; height: 160px; padding-top: 8px; }
.bar { flex: 1; min-width: 4px; height: 100%; display: flex; align-items: flex-end; border-radius: var(--radius-xs); background: var(--hover); overflow: hidden; }
.bar span { display: block; }
.bar .a { background: var(--chart-ok); } .bar .r { background: var(--chart-warn); } .bar .x { background: var(--chart-bad); }
.chart-axis { display: flex; justify-content: space-between; margin-top: 8px; font-size: var(--fs-xs); color: var(--text-mut); }
.legend { display: flex; gap: 16px; font-size: var(--fs-sm); color: var(--text-mut); margin-top: 12px; }

.flag-row { display: flex; justify-content: space-between; gap: 12px; padding: 12px 0; border-top: 1px solid var(--divider); }
.flag-row:first-of-type { border-top: 0; padding-top: 0; }
.flag-row b { font-weight: 500; }
.flag-row p { margin: 2px 0 0; font-size: var(--fs-sm); color: var(--text-mut); }
.flag-row .count { font-variant-numeric: tabular-nums; font-weight: 500; font-size: var(--fs-lg); }

/* Tables bleed to the card edges, as in the console. */
.table-wrap { overflow-x: auto; margin: 0 -24px -24px; border-top: 1px solid var(--border); }
table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
th { text-align: left; font-size: var(--fs-sm); font-weight: 500; color: var(--text-mut); padding: 12px 16px; border-bottom: 1px solid var(--border); white-space: nowrap; }
td { padding: 13px 16px; border-bottom: 1px solid var(--divider); vertical-align: middle; }
th:first-child, td:first-child { padding-left: 24px; }
th:last-child, td:last-child { padding-right: 24px; }
tr:last-child td { border-bottom: 0; }
tbody tr { transition: background var(--t-fast) var(--ease-out); }
tbody tr:hover { background: var(--row-hover); }
td.num { font-weight: 500; }
.pill { display: inline-flex; align-items: center; padding: 3px 10px; border-radius: var(--radius-pill); font-size: var(--fs-sm); font-weight: 600; line-height: 1.4; white-space: nowrap; text-transform: capitalize; }
.pill.approved { background: var(--ok-soft); color: var(--ok); }
.pill.review { background: var(--warn-soft); color: var(--warn); }
.pill.reject { background: var(--bad-soft); color: var(--bad); }
.chip { display: inline-block; padding: 2px 9px; margin: 2px 4px 2px 0; border-radius: var(--radius-pill); background: var(--hover); font-size: var(--fs-xs); color: var(--text-mut); white-space: nowrap; }
.cert { color: var(--text); text-decoration: none; }
.cert:hover { text-decoration: underline; }

.empty { text-align: center; padding: 48px 24px; color: var(--text-mut); }
.empty h2 { color: var(--text); margin-bottom: 6px; }
.empty p { margin: 0 auto 18px; max-width: 48ch; }

/* Setup */
.step { display: grid; grid-template-columns: 32px 1fr; gap: 16px; }
.step-num { width: 28px; height: 28px; border-radius: 50%; display: grid; place-items: center; font-size: var(--fs-sm); font-weight: 600; background: var(--hover); color: var(--text-mut); border: 1px solid var(--border); }
.step-num.done { background: var(--accent); color: #1a1a18; border-color: var(--accent); }
.row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.row input { flex: 1; min-width: 200px; }
.secret { margin-top: 16px; border: 1px solid var(--border); background: var(--accent-soft); border-radius: var(--radius-sm); padding: 14px 16px; }
.secret .mono { word-break: break-all; display: block; margin: 6px 0 10px; color: var(--text); }
.list { margin-top: 14px; }
.list-item { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 12px 0; border-top: 1px solid var(--divider); }
.list-item.revoked { opacity: .55; }
.code { background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 12px 16px; overflow-x: auto; white-space: pre; margin: 8px 0 0; }
.kv { display: grid; grid-template-columns: max-content 1fr auto; gap: 10px 24px; align-items: center; margin-top: 8px; }
.kv .mono { word-break: break-all; }

@media (max-width: 860px) { .two { grid-template-columns: 1fr; } }
@media (max-width: 560px) {
  .appbar { padding: 0 16px; } .tabs { padding: 0 12px; } .page { padding: 20px 16px 64px; }
  .who, .product { display: none; }
  .brand-logo { height: 22px; }
  .auth-card { padding: 28px 22px; }
  .kpis { grid-template-columns: repeat(2, 1fr); }
  .kpi .value { font-size: var(--fs-2xl); }
  .card { padding: 18px 16px 20px; } .table-wrap { margin: 0 -16px -20px; }
  th:first-child, td:first-child { padding-left: 16px; } th:last-child, td:last-child { padding-right: 16px; }
  .kv { grid-template-columns: 1fr auto; } .kv .k { grid-column: 1 / -1; margin-bottom: -6px; }
  .hide-sm { display: none; }
}
`;
