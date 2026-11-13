// The weekly labelling page at /portal/labels, for Solcertain's operator only.
// It is not part of the customer portal's navigation and holds no session: the
// operator unlocks it with INTERNAL_API_KEY, kept in this tab's sessionStorage
// only, and every call sends it as x-api-key. Without the key it shows nothing.
// Served by routes/portal_pages.ts under the same CSP as the portal (scripts
// from 'self' only), and styled by the portal's own app.css.

export const LABELS_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Label Queue</title>
<link rel="icon" href="/portal/brand/mark.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@300..700&family=Geist+Mono:wght@400;500&display=swap">
<link rel="stylesheet" href="/portal/app.css">
<link rel="stylesheet" href="/portal/labels.css">
<script src="/portal/theme.js"></script>
</head>
<body>
<div id="app"><p class="boot">Loading…</p></div>
<script src="/portal/labels.js"></script>
</body>
</html>`;

export const LABELS_CSS = `
.lq { max-width: 880px; margin: 0 auto; padding: 24px 16px 64px; }
.lq h1 { font-size: 22px; margin: 0 0 4px; }
.lq-sub { color: var(--text-mut); margin: 0 0 20px; }
.lq-bar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 16px; }
.lq-item { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 16px; margin-bottom: 12px; }
.lq-item.done { opacity: .5; }
.lq-head { display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; align-items: baseline; }
.lq-why { font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: var(--text-mut); }
.lq-meta { color: var(--text-mut); font-size: 13px; margin: 6px 0; }
.lq-flags { display: flex; gap: 6px; flex-wrap: wrap; margin: 8px 0; }
.lq-flag { font-family: "Geist Mono", monospace; font-size: 12px; padding: 2px 8px; border-radius: 999px; background: var(--warn-soft); color: var(--warn); }
.lq-flag.shadow { background: var(--brand-soft); color: var(--text-mut); }
.lq-ev { margin: 8px 0 0; padding-left: 18px; font-size: 13px; }
.lq-return { margin: 10px 0 0; padding: 8px 12px; border-left: 3px solid var(--warn); background: var(--warn-soft); font-size: 14px; }
.lq-actions { display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; }
.lq-result { font-size: 13px; color: var(--text-mut); margin-top: 8px; }
.lq input[type=password] { flex: 1 1 260px; min-width: 0; padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--card); color: var(--text); font: inherit; }
`;

export const LABELS_JS = `(function () {
  "use strict";
  var KEY_STORE = "vs.labels.key";
  var root = document.getElementById("app");
  var WHY = {
    held_back: "Held back by the engine",
    fraud_return: "Buyer return sounds like fraud",
    control: "Random approved lead (control)"
  };
  var RESULT = {
    caught: "Recorded. The engine caught this one.",
    missed: "Recorded. The engine missed this one, which is exactly what we need to learn from.",
    false_alarm: "Recorded. The engine held back a real person, a false alarm.",
    correctly_approved: "Recorded. The engine approved a real person."
  };

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function get_key() { try { return sessionStorage.getItem(KEY_STORE); } catch (e) { return null; } }
  function set_key(k) { try { if (k) sessionStorage.setItem(KEY_STORE, k); else sessionStorage.removeItem(KEY_STORE); } catch (e) {} }

  function api(path, opts) {
    opts = opts || {};
    opts.headers = Object.assign({ "x-api-key": get_key() || "", "Content-Type": "application/json" }, opts.headers || {});
    return fetch(path, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (body) {
        if (r.status === 401) { set_key(null); throw new Error("That key was not accepted."); }
        if (!r.ok) throw new Error(body.error || ("Request failed (" + r.status + ")"));
        return body;
      });
    });
  }

  function unlock(message) {
    root.textContent = "";
    var page = el("div", "lq");
    page.appendChild(el("h1", null, "Label queue"));
    page.appendChild(el("p", "lq-sub", "Operator only. Enter the internal API key to load this week's leads. It is kept in this tab only."));
    if (message) page.appendChild(el("div", "alert alert-bad", message));
    var form = el("form", "lq-bar");
    var input = el("input");
    input.type = "password"; input.autocomplete = "off"; input.placeholder = "Internal API key";
    var btn = el("button", "btn btn-primary", "Unlock");
    btn.type = "submit";
    form.appendChild(input); form.appendChild(btn);
    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      if (!input.value.trim()) return;
      set_key(input.value.trim());
      load(7);
    });
    page.appendChild(form);
    root.appendChild(page);
    input.focus();
  }

  function fmt_when(iso) {
    try { return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); } catch (e) { return iso; }
  }

  function meta_line(it) {
    var parts = [];
    parts.push(fmt_when(it.received_at));
    if (it.score != null) parts.push("score " + it.score + " (" + (it.status || "?") + ")");
    if (it.device) parts.push(it.device + (it.is_mobile ? ", phone" : ""));
    if (it.kpm != null) parts.push(Math.round(it.kpm) + " keys/min" + (it.wpm != null ? ", " + Math.round(it.wpm) + " words/min" : ""));
    if (it.seconds_on_page != null) parts.push(it.seconds_on_page + "s on page");
    if (it.outcome) parts.push("outcome: " + it.outcome);
    return parts.join(" · ");
  }

  function card(it) {
    var c = el("div", "lq-item");
    var head = el("div", "lq-head");
    head.appendChild(el("span", "lq-why", WHY[it.reason] || it.reason));
    head.appendChild(el("span", "mono small", it.analysis_id.slice(0, 8)));
    c.appendChild(head);
    c.appendChild(el("div", "lq-meta", meta_line(it)));
    if (it.flags.length || it.shadow_flags.length) {
      var flags = el("div", "lq-flags");
      it.flags.forEach(function (f) { flags.appendChild(el("span", "lq-flag", f)); });
      it.shadow_flags.forEach(function (f) { flags.appendChild(el("span", "lq-flag shadow", f + " (shadow)")); });
      c.appendChild(flags);
    }
    if (it.evidence.length) {
      var ul = el("ul", "lq-ev");
      it.evidence.forEach(function (e) { ul.appendChild(el("li", null, e)); });
      c.appendChild(ul);
    }
    if (it.return_reason) c.appendChild(el("div", "lq-return", "Buyer said: " + it.return_reason));

    var actions = el("div", "lq-actions");
    var result = el("div", "lq-result");
    function label(kind) {
      Array.prototype.forEach.call(actions.querySelectorAll("button"), function (b) { b.disabled = true; });
      api("/api/outcomes/label", {
        method: "POST",
        body: JSON.stringify({ analysis_id: it.analysis_id, label: kind, labelled_by: "label-queue", reason: WHY[it.reason] })
      }).then(function (body) {
        c.classList.add("done");
        result.textContent = (kind === "fraud" ? "Fraud. " : "Genuine. ") + (RESULT[body.engine_result] || "Recorded.");
      }).catch(function (e) {
        result.textContent = e.message;
        Array.prototype.forEach.call(actions.querySelectorAll("button"), function (b) { b.disabled = false; });
      });
    }
    var fraud = el("button", "btn btn-danger btn-sm", "Fraud");
    var genuine = el("button", "btn btn-primary btn-sm", "Genuine");
    var skip = el("button", "btn btn-sm", "Skip");
    fraud.addEventListener("click", function () { label("fraud"); });
    genuine.addEventListener("click", function () { label("genuine"); });
    skip.addEventListener("click", function () { c.classList.add("done"); result.textContent = "Skipped. It will be back next week if still unlabelled."; });
    actions.appendChild(fraud); actions.appendChild(genuine); actions.appendChild(skip);
    c.appendChild(actions);
    c.appendChild(result);
    return c;
  }

  function render(days, data) {
    root.textContent = "";
    var page = el("div", "lq");
    page.appendChild(el("h1", null, "Label queue"));
    page.appendChild(el("p", "lq-sub", data.count + " leads from the last " + days + " days need a person's verdict. Mark each Fraud if the person did not really submit (a bot, a farm, someone who never filled the form), Genuine if a real homeowner did. Skip when you cannot tell."));
    var bar = el("div", "lq-bar");
    [7, 30, 90].forEach(function (d) {
      var b = el("button", "btn btn-sm" + (d === days ? " btn-primary" : ""), d + " days");
      b.addEventListener("click", function () { load(d); });
      bar.appendChild(b);
    });
    var lock = el("button", "btn btn-sm", "Lock");
    lock.addEventListener("click", function () { set_key(null); unlock(); });
    bar.appendChild(lock);
    page.appendChild(bar);
    if (!data.items.length) page.appendChild(el("div", "empty", "Nothing to label. Every lead in this window has a verdict."));
    data.items.forEach(function (it) { page.appendChild(card(it)); });
    root.appendChild(page);
  }

  function load(days) {
    if (!get_key()) return unlock();
    root.textContent = "";
    root.appendChild(el("p", "boot", "Loading…"));
    api("/api/admin/label-queue?days=" + days).then(function (data) { render(days, data); })
      .catch(function (e) { unlock(e.message); });
  }

  load(7);
})();`;
