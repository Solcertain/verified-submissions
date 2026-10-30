// The customer portal's browser script, served at /portal/app.js by
// routes/portal_pages.ts; the page shell and styles are in shell.ts. Plain
// browser JavaScript with no build step and nothing loaded from another site,
// run under a strict Content-Security-Policy. It builds the page with DOM calls
// and textContent only: no server data is ever parsed as HTML.
//
// Kept as a string rather than a file because Vercel compiles this package file
// by file and does not ship non-TypeScript assets alongside it. The script uses
// no template literals, so it can live inside one.

export { PORTAL_CSS, PORTAL_HTML, PORTAL_THEME_JS } from "./shell.js";

export const PORTAL_JS = String.raw`
(function () {
  "use strict";
  var root = document.getElementById("app");
  var BASE = "/portal";
  var state = { days: 7, me: null, flash: null };

  var FLAGS = {
    synthetic_typing: ["Synthetic typing", "Keystroke timing no person produces: the hallmark of AI browser agents and scripts."],
    superhuman_typing_speed: ["Superhuman typing speed", "Typed faster than any person can, which points to a script filling the form."],
    automation_environment: ["Automation environment", "Desktop Linux on an IP with no location, typical of headless browsers and agents."],
    bot_detected: ["Bot detected", "TrustedForm's own bot check failed for this session."],
    certificate_reused: ["Certificate reused", "The same certificate was sent with a different lead."],
    certificate_page_mismatch: ["Certificate from another page", "The certificate was captured on a page other than the one the lead came from."],
    stale_certificate: ["Stale certificate", "Captured more than 30 minutes before it was checked."],
    consent_language_missing: ["Consent language missing", "The required TCPA disclosure was not found on the form."],
    instant_submission: ["Instant submission", "The form was submitted almost as soon as it loaded."],
    brief_session: ["Very short session", "Too little time on the page for a person to read and fill the form."],
    no_typing_observed: ["No typing observed", "Every field was filled without a keystroke."],
    pasted_input: ["Pasted input", "Fields were pasted in rather than typed."],
    analysis_unavailable: ["Not analysed", "The certificate could not be retrieved, so the lead was held for review."]
  };

  // ── Helpers ────────────────────────────────────────────────────────────
  function h(tag, attrs) {
    var el = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v === null || v === undefined || v === false) return;
        if (k === "text") el.textContent = v;
        else if (k === "class") el.className = v;
        // Through the CSSOM: the CSP refuses style attributes set as markup.
        else if (k === "style") el.style.cssText = v;
        else if (k.slice(0, 2) === "on") el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? "" : v);
      });
    }
    for (var i = 2; i < arguments.length; i++) add(el, arguments[i]);
    return el;
  }
  // Appends any number of children: nodes, strings, arrays; skips empty values.
  function add(el) {
    for (var i = 1; i < arguments.length; i++) {
      var c = arguments[i];
      if (c === null || c === undefined || c === false) continue;
      if (Array.isArray(c)) { c.forEach(function (x) { add(el, x); }); continue; }
      el.appendChild(typeof c === "string" || typeof c === "number" ? document.createTextNode(String(c)) : c);
    }
  }
  function mount(node) { root.textContent = ""; root.appendChild(node); }

  function api(method, path, body) {
    var opts = { method: method, credentials: "same-origin", headers: {} };
    if (body !== undefined) { opts.headers["content-type"] = "application/json"; opts.body = JSON.stringify(body); }
    return fetch("/api/portal" + path, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) { j.status_code = r.status; return j; });
    }, function () { return { ok: false, status_code: 0, error: "Can't reach the server. Check your connection." }; });
  }

  function go(path, replace) {
    if (replace) history.replaceState(null, "", BASE + path); else history.pushState(null, "", BASE + path);
    render();
  }
  window.addEventListener("popstate", render);

  function copy(text, btn) {
    function done() { var t = btn.textContent; btn.textContent = "Copied"; setTimeout(function () { btn.textContent = t; }, 1500); }
    if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, function () {});
  }
  function copyBtn(text) {
    var b = h("button", { class: "btn btn-ghost btn-sm", type: "button", text: "Copy" });
    b.addEventListener("click", function () { copy(text, b); });
    return b;
  }
  function fmtTime(iso) {
    var d = new Date(iso);
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + ", " + d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }
  // A bare YYYY-MM-DD is a calendar day: read it at local noon so no time zone shifts it.
  function fmtDate(iso) {
    if (!iso) return "";
    var d = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(iso + "T12:00:00") : new Date(iso);
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  }
  function pct(n, d) { return d ? Math.round((100 * n) / d) + "%" : "—"; }
  function alertBox(kind, text) { return h("div", { class: "alert alert-" + kind, role: kind === "bad" ? "alert" : "status", text: text }); }
  // The VerifiedSubmission wordmark; both theme variants, CSS shows one.
  function logo() {
    return h("span", { class: "brand-logo" },
      h("img", { class: "light", src: BASE + "/brand/logo-light.svg", alt: "VerifiedSubmission" }),
      h("img", { class: "dark", src: BASE + "/brand/logo-dark.svg", alt: "", "aria-hidden": "true" }));
  }

  // Light by default, as in the console; the choice is kept in this browser.
  function currentTheme() { return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light"; }
  function themeButton() {
    var b = h("button", { class: "bar-btn", type: "button" });
    function label() { b.textContent = currentTheme() === "dark" ? "Light" : "Dark"; b.setAttribute("aria-label", "Switch to " + b.textContent.toLowerCase() + " theme"); }
    b.addEventListener("click", function () {
      var t = currentTheme() === "dark" ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", t);
      try { localStorage.setItem("vs.portal.theme", t); } catch (e) {}
      label();
    });
    label();
    return b;
  }

  // ── Router ─────────────────────────────────────────────────────────────
  function render() {
    var p = location.pathname.replace(/^\/portal/, "").replace(/\/$/, "") || "/";
    if (p === "/login") return loginPage();
    if (p === "/forgot") return forgotPage();
    if (p === "/set-password" || p === "/reset-password") return passwordPage(p === "/reset-password");
    return appPage(p === "/setup" ? "setup" : "activity");
  }

  // ── Sign-in pages ──────────────────────────────────────────────────────
  function authCard(title, lead, body) {
    mount(h("main", { class: "auth" }, h("div", { class: "auth-card" },
      h("div", { class: "wordmark" }, logo(), h("small", { text: "portal" })),
      h("h1", { text: title }), lead ? h("p", { class: "lead", text: lead }) : null, body)));
  }

  function loginPage() {
    var msg = h("div");
    var email = h("input", { type: "email", id: "email", autocomplete: "username", required: true });
    var pw = h("input", { type: "password", id: "password", autocomplete: "current-password", required: true });
    var btn = h("button", { class: "btn btn-primary btn-block", type: "submit", text: "Sign in" });
    var form = h("form", { novalidate: true },
      h("label", { for: "email", text: "Email" }), email,
      h("label", { for: "password", text: "Password" }), pw,
      msg, btn,
      h("div", { class: "auth-foot" }, h("button", { type: "button", class: "link-btn", text: "Forgot your password?", onclick: function () { go("/forgot"); } })));
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      btn.disabled = true; msg.textContent = "";
      api("POST", "/login", { email: email.value.trim(), password: pw.value }).then(function (r) {
        btn.disabled = false;
        if (r.ok) { state.me = null; go("/", true); } else { add(msg, alertBox("bad", r.error || "Sign-in failed")); pw.value = ""; pw.focus(); }
      });
    });
    authCard("Sign in", "Your verification activity and API setup.", form);
    email.focus();
  }

  function forgotPage() {
    var msg = h("div");
    var email = h("input", { type: "email", id: "email", autocomplete: "username", required: true });
    var btn = h("button", { class: "btn btn-primary btn-block", type: "submit", text: "Send reset link" });
    var form = h("form", { novalidate: true }, h("label", { for: "email", text: "Email" }), email, msg, btn,
      h("div", { class: "auth-foot" }, h("button", { type: "button", class: "link-btn", text: "Back to sign in", onclick: function () { go("/login"); } })));
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      if (!email.value.trim()) return;
      btn.disabled = true;
      api("POST", "/forgot", { email: email.value.trim() }).then(function () {
        msg.textContent = "";
        add(msg, alertBox("ok", "If that email has an account, a reset link is on its way. It expires in an hour. Nothing arrived? Reply to your welcome email and we'll send one."));
      });
    });
    authCard("Reset your password", "We'll email you a link to choose a new one.", form);
    email.focus();
  }

  function passwordPage(isReset) {
    var token = new URLSearchParams(location.search).get("t") || "";
    var msg = h("div");
    var pw = h("input", { type: "password", id: "pw", autocomplete: "new-password", minlength: "10", required: true });
    var pw2 = h("input", { type: "password", id: "pw2", autocomplete: "new-password", required: true });
    var btn = h("button", { class: "btn btn-primary btn-block", type: "submit", text: isReset ? "Reset password" : "Set password and continue" });
    var form = h("form", { novalidate: true },
      h("label", { for: "pw", text: "New password" }), pw,
      h("p", { class: "small muted", text: "At least 10 characters." }),
      h("label", { for: "pw2", text: "Confirm password" }), pw2, msg, btn);
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      msg.textContent = "";
      if (pw.value.length < 10) { add(msg, alertBox("bad", "Use at least 10 characters.")); return; }
      if (pw.value !== pw2.value) { add(msg, alertBox("bad", "The passwords don't match.")); return; }
      btn.disabled = true;
      api("POST", "/set-password", { token: token, password: pw.value }).then(function (r) {
        btn.disabled = false;
        if (r.ok) { state.me = null; go(isReset ? "/" : "/setup", true); } else add(msg, alertBox("bad", r.error || "Couldn't set the password"));
      });
    });
    if (!token) { authCard("Link incomplete", "This page needs the full link from your email.", h("p", null, h("button", { class: "link-btn", text: "Go to sign in", onclick: function () { go("/login"); } }))); return; }
    authCard(isReset ? "Choose a new password" : "Welcome — set your password", isReset ? null : "You'll use it to sign in to your portal.", form);
    pw.focus();
  }

  // ── Signed-in shell ────────────────────────────────────────────────────
  function appPage(tab) {
    var load = state.me ? Promise.resolve({ ok: true, cached: true }) : api("GET", "/me").then(function (r) { if (r.ok) state.me = r; return r; });
    load.then(function (r) {
      if (!r.ok) { if (r.status_code === 401) go("/login", true); else mount(h("p", { class: "boot", text: r.error || "Something went wrong." })); return; }
      var content = h("main", { class: "page" });
      mount(h("div", null, topbar(tab), content));
      if (tab === "setup") setupView(content); else activityView(content);
    });
  }

  function topbar(tab) {
    function link(name, path, key) {
      return h("a", { class: "tab" + (tab === key ? " active" : ""), href: BASE + path, onclick: function (e) { e.preventDefault(); go(path); } }, name);
    }
    var out = h("button", { class: "bar-btn", type: "button", text: "Sign out" });
    out.addEventListener("click", function () { api("POST", "/logout", {}).then(function () { state.me = null; go("/login", true); }); });
    return h("div", null,
      h("header", { class: "appbar" },
        h("div", { class: "brand" }, logo(), h("span", { class: "product", text: "Portal" })),
        h("div", { class: "appbar-right" }, h("span", { class: "who", title: state.me.email, text: state.me.email }), themeButton(), out)),
      h("nav", { class: "tabs", "aria-label": "Portal" }, link("Activity", "/", "activity"), link("Setup", "/setup", "setup")));
  }

  function statusBanner() {
    var s = state.me.customer.status;
    if (s === "past_due") return alertBox("warn", "Your last payment didn't go through. Verification keeps working for a few days; update your card to avoid interruption.");
    if (s === "pending_payment") return alertBox("warn", "Your account isn't active yet, so verification requests are refused until checkout is complete.");
    return null;
  }

  // ── Activity ───────────────────────────────────────────────────────────
  function activityView(el) {
    var seg = h("div", { class: "seg", role: "group", "aria-label": "Period" });
    [7, 30].forEach(function (d) {
      seg.appendChild(h("button", { type: "button", class: state.days === d ? "on" : "", "aria-pressed": state.days === d ? "true" : "false", text: "Last " + d + " days",
        onclick: function () { state.days = d; activityView(el); } }));
    });
    el.textContent = "";
    add(el, statusBanner());
    add(el, h("div", { class: "page-head" }, h("div", null, h("h1", { text: state.me.customer.name }), h("p", { text: "Every lead you've sent us, and what we decided." })), seg));
    var body = h("div", null, h("p", { class: "muted", text: "Loading activity…" }));
    add(el, body);

    api("GET", "/dashboard?days=" + state.days).then(function (d) {
      body.textContent = "";
      if (!d.ok) { add(body, alertBox("bad", d.error || "Couldn't load your activity")); return; }
      if (!d.scored) { add(body, emptyState()); return; }
      var s = d.by_status || {};
      var approved = s.approved || 0, review = s.review || 0, reject = s.reject || 0;
      add(body, h("div", { class: "grid kpis" },
        kpi("Leads verified", d.scored, "in the last " + d.days + " days"),
        kpi("Approved", approved, pct(approved, d.scored) + " of leads", "ok"),
        kpi("Held for review", review, pct(review, d.scored) + " of leads", "warn"),
        kpi("Rejected", reject, pct(reject, d.scored) + " of leads", "bad")));
      add(body, h("div", { class: "grid two" }, chartCard(d.daily), flagsCard(d.risk_flags || {}, d.scored)));
      add(body, recentCard(d.recent || []));
    });
  }

  function kpi(label, value, note, tone) {
    return h("div", { class: "card kpi" }, h("div", { class: "label" }, tone ? h("span", { class: "dot " + tone }) : null, label),
      h("div", { class: "value", text: String(value) }), h("div", { class: "note", text: note }));
  }

  function chartCard(daily) {
    var max = 1;
    daily.forEach(function (x) { max = Math.max(max, x.approved + x.review + x.reject); });
    var chart = h("div", { class: "chart", role: "img", "aria-label": "Leads verified per day" });
    daily.forEach(function (x) {
      var total = x.approved + x.review + x.reject;
      var bar = h("div", { class: "bar", title: x.date + ": " + total + " leads (" + x.approved + " approved, " + x.review + " review, " + x.reject + " rejected)" });
      var inner = h("div", { style: "height:" + Math.round((100 * total) / max) + "%;display:flex;flex-direction:column-reverse;width:100%" });
      [["a", x.approved], ["r", x.review], ["x", x.reject]].forEach(function (p) {
        if (p[1]) inner.appendChild(h("span", { class: p[0], style: "height:" + (100 * p[1]) / total + "%" }));
      });
      bar.appendChild(inner);
      chart.appendChild(bar);
    });
    var first = daily[0] ? daily[0].date : "", last = daily.length ? daily[daily.length - 1].date : "";
    return h("section", { class: "card" }, h("h2", { text: "Leads per day" }), h("p", { class: "sub", text: "Hover a bar for the day's numbers." }), chart,
      h("div", { class: "chart-axis" }, h("span", { text: fmtDate(first) }), h("span", { text: fmtDate(last) })),
      h("div", { class: "legend" }, h("span", null, h("span", { class: "dot ok" }), "Approved"), h("span", null, h("span", { class: "dot warn" }), "Review"), h("span", null, h("span", { class: "dot bad" }), "Rejected")));
  }

  function flagsCard(flags, scored) {
    var keys = Object.keys(flags);
    var card = h("section", { class: "card" }, h("h2", { text: "Why leads were flagged" }), h("p", { class: "sub", text: "A lead can carry more than one." }));
    if (!keys.length) { add(card, h("p", { class: "muted", text: "No risk signals on any lead in this period." })); return card; }
    keys.slice(0, 6).forEach(function (k) {
      var info = FLAGS[k] || [k.replace(/_/g, " "), ""];
      add(card, h("div", { class: "flag-row" }, h("div", null, h("b", { text: info[0] }), info[1] ? h("p", { text: info[1] }) : null),
        h("div", { class: "count", title: pct(flags[k], scored) + " of leads", text: String(flags[k]) })));
    });
    return card;
  }

  function recentCard(rows) {
    var tbody = h("tbody");
    rows.forEach(function (r) {
      var cert = r.certificate_id || "";
      tbody.appendChild(h("tr", null,
        h("td", { class: "small", style: "white-space:nowrap", text: fmtTime(r.received_at) }),
        h("td", null, cert ? certCell(cert) : h("span", { class: "muted", text: "—" })),
        h("td", { class: "num", text: r.score === null ? "—" : String(r.score) }),
        h("td", null, h("span", { class: "pill " + (r.status || ""), text: r.status || "—" })),
        h("td", null, r.flags.length ? r.flags.map(function (f) { return h("span", { class: "chip", title: (FLAGS[f] || [])[1] || "", text: (FLAGS[f] || [f])[0] }); }) : h("span", { class: "muted small", text: "None" })),
        h("td", { class: "small muted hide-sm", text: r.source })));
    });
    return h("section", { class: "card" }, h("h2", { text: "Recent leads" }),
      h("p", { class: "sub", text: "Newest first. The certificate id is how you find a lead in your own system." }),
      h("div", { class: "table-wrap" }, h("table", null,
        h("thead", null, h("tr", null, h("th", { text: "Received" }), h("th", { text: "Certificate" }), h("th", { text: "Score" }), h("th", { text: "Verdict" }), h("th", { text: "Flags" }), h("th", { class: "hide-sm", text: "Source" }))),
        tbody)));
  }

  // Shows the start of the certificate id; a click copies all of it.
  function certCell(cert) {
    var b = h("button", { type: "button", class: "link-btn cert mono", title: cert + " (click to copy)", "aria-label": "Copy certificate id " + cert, text: cert.slice(0, 10) + "…" });
    b.addEventListener("click", function () { copy(cert, b); });
    return b;
  }

  function emptyState() {
    var ready = state.me.activeprospect_key_set && state.me.api_keys.some(function (k) { return !k.revoked_at; });
    return h("section", { class: "card empty" }, h("h2", { text: "No leads verified in this period" }),
      h("p", { text: ready ? "Your account is set up. Leads appear here as soon as your system sends them." : "Finish setup to start verifying leads: add your ActiveProspect key and create an API key." }),
      h("button", { class: "btn btn-primary", type: "button", text: ready ? "View integration guide" : "Go to setup", onclick: function () { go("/setup"); } }));
  }

  // ── Setup ──────────────────────────────────────────────────────────────
  function setupView(el) {
    var me = state.me;
    var activeKeys = me.api_keys.filter(function (k) { return !k.revoked_at; });
    var activeTokens = me.outcome_tokens.filter(function (t) { return !t.revoked_at; });
    el.textContent = "";
    add(el, statusBanner());
    add(el, h("div", { class: "page-head" }, h("div", null, h("h1", { text: "Setup" }), h("p", { text: "Three steps to start verifying leads, then wire up your platform." }))));
    add(el, step(1, me.activeprospect_key_set, "Connect ActiveProspect", "We read each TrustedForm certificate on your own ActiveProspect account, so claims and billing stay with you.", apSection()));
    add(el, step(2, activeKeys.length > 0, "Create an API key", "Your system sends this key in the x-api-key header with every verification.", keysSection()));
    add(el, step(3, activeTokens.length > 0, "Report outcomes (recommended)", "Tell us which leads sold or were returned, so your scores get checked against real results.", tokensSection()));
    add(el, guideCard());
    state.flash = null;
  }

  function refreshMe(then) {
    api("GET", "/me").then(function (r) { if (r.ok) { state.me = r; if (then) then(); } else if (r.status_code === 401) go("/login", true); });
  }
  function rerenderSetup() { refreshMe(function () { setupView(document.querySelector("main.page")); }); }

  function step(n, done, title, sub, body) {
    return h("section", { class: "card" }, h("div", { class: "step" },
      h("div", { class: "step-num" + (done ? " done" : ""), "aria-label": done ? "Done" : "Step " + n, text: done ? "✓" : String(n) }),
      h("div", null, h("h2", { text: title }), h("p", { class: "sub", text: sub }), body)));
  }

  function apSection() {
    var wrap = h("div");
    var msg = h("div");
    var input = h("input", { type: "password", id: "apkey", autocomplete: "off", placeholder: "Paste your ActiveProspect API key", "aria-label": "ActiveProspect API key" });
    var btn = h("button", { class: "btn btn-primary", type: "submit", text: state.me.activeprospect_key_set ? "Replace key" : "Save key" });
    var form = h("form", { class: "row" }, input, btn);
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      if (!input.value.trim()) return;
      btn.disabled = true; msg.textContent = "";
      api("PUT", "/activeprospect-key", { key: input.value.trim() }).then(function (r) {
        btn.disabled = false;
        if (r.ok) { input.value = ""; rerenderSetup(); } else add(msg, alertBox("bad", r.error || "Couldn't save the key"));
      });
    });
    if (state.me.activeprospect_key_set) add(wrap, h("p", { class: "small", style: "margin:0 0 10px" }, h("span", { class: "dot ok" }), "Connected. The key is stored encrypted and is never shown again."));
    add(wrap, form, msg, h("p", { class: "small muted", style: "margin:8px 0 0" }, "It's the API key from your ActiveProspect account settings, the one you use for TrustedForm."));
    return wrap;
  }

  function secretBox(title, value) {
    return h("div", { class: "secret", role: "status" }, h("b", { text: title }), h("span", { class: "mono", text: value }),
      h("div", { class: "row" }, copyBtn(value), h("span", { class: "small", text: "Copy it now. For your security we can't show it again." })));
  }

  // A secret just created survives the re-render that updates the step badges,
  // once: the next render of the page drops it.
  function showFlash(section, into) {
    if (state.flash && state.flash.section === section) add(into, secretBox(state.flash.title, state.flash.value));
  }

  function keysSection() {
    var wrap = h("div");
    var shown = h("div");
    var label = h("input", { type: "text", placeholder: "Label, e.g. Lead Prosper", maxlength: "60", "aria-label": "Key label" });
    var btn = h("button", { class: "btn btn-primary", type: "submit", text: "Create key" });
    var form = h("form", { class: "row" }, label, btn);
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      btn.disabled = true;
      api("POST", "/api-keys", { label: label.value.trim() || undefined }).then(function (r) {
        btn.disabled = false;
        if (!r.ok) { add(shown, alertBox("bad", r.error || "Couldn't create a key")); return; }
        state.flash = { section: "keys", title: "Your new API key", value: r.key };
        rerenderSetup();
      });
    });
    showFlash("keys", shown);
    add(wrap, form, shown, keyList());
    return wrap;
  }

  function keyList() {
    var list = h("div", { class: "list" });
    state.me.api_keys.slice().reverse().forEach(function (k) {
      var revoke = k.revoked_at ? h("span", { class: "small muted", text: "Revoked " + fmtDate(k.revoked_at) }) : h("button", { class: "btn btn-danger btn-sm", type: "button", text: "Revoke",
        onclick: function () {
          if (!confirm("Revoke this key? Anything still using it will be refused immediately.")) return;
          api("DELETE", "/api-keys/" + encodeURIComponent(k.id)).then(rerenderSetup);
        } });
      add(list, h("div", { class: "list-item" + (k.revoked_at ? " revoked" : "") },
        h("div", null, h("div", null, h("span", { class: "mono", text: k.prefix + "_…" }), k.label ? h("span", { class: "muted", text: "  " + k.label }) : null),
          h("div", { class: "small muted", text: "Created " + fmtDate(k.created_at) + (k.last_used_at ? " · last used " + fmtTime(k.last_used_at) : " · not used yet") })),
        revoke));
    });
    return list;
  }

  function tokensSection() {
    var wrap = h("div");
    var shown = h("div");
    var btn = h("button", { class: "btn btn-primary", type: "button", text: "Create outcome URL" });
    btn.addEventListener("click", function () {
      btn.disabled = true;
      api("POST", "/outcome-tokens", {}).then(function (r) {
        btn.disabled = false;
        if (!r.ok) { add(shown, alertBox("bad", r.error || "Couldn't create the URL")); return; }
        state.flash = { section: "tokens", title: "Your outcome URL", value: r.url };
        rerenderSetup();
      });
    });
    showFlash("tokens", shown);
    add(wrap, h("div", { class: "row" }, btn), shown, tokenList());
    return wrap;
  }

  function tokenList() {
    var list = h("div", { class: "list" });
    state.me.outcome_tokens.slice().reverse().forEach(function (t) {
      var revoke = t.revoked_at ? h("span", { class: "small muted", text: "Revoked " + fmtDate(t.revoked_at) }) : h("button", { class: "btn btn-danger btn-sm", type: "button", text: "Revoke",
        onclick: function () {
          if (!confirm("Revoke this outcome URL? Outcomes sent to it will be refused.")) return;
          api("DELETE", "/outcome-tokens/" + encodeURIComponent(t.id)).then(rerenderSetup);
        } });
      add(list, h("div", { class: "list-item" + (t.revoked_at ? " revoked" : "") },
        h("div", null, h("div", { class: "mono", text: state.me.outcome_url_base + "…" }), h("div", { class: "small muted", text: "Created " + fmtDate(t.created_at) })), revoke));
    });
    return list;
  }

  function guideCard() {
    var me = state.me;
    var curl = "curl -X POST " + me.verify_url + " \\\n" +
      "  -H \"x-api-key: YOUR_API_KEY\" \\\n" +
      "  -H \"content-type: application/json\" \\\n" +
      "  -d '{\"certificate_url\": \"https://cert.trustedform.com/…\",\n" +
      "       \"lead\": {\"state\": \"TX\"}}'";
    var resp = "{ \"status\": \"approved\",   // approved | review | reject\n" +
      "  \"action\": \"accept\",\n  \"score\": 94,\n  \"flags\": [],\n  \"reasons\": [\"…\"] }";
    var outcome = "POST <your outcome URL>\n{ \"certificate_url\": \"https://cert.trustedform.com/…\", \"outcome\": \"sold\" }\n// outcome: accepted | sold | returned | rejected\n// optional: lead_id (instead of certificate_url), reason (for returns), buyer, price";
    return h("section", { class: "card" }, h("h2", { text: "Integration guide" }),
      h("p", { class: "sub", text: "Call verify when a lead arrives, before you sell or accept it. Decide on status: approved leads are safe to sell, review leads deserve a look, reject leads should be stopped." }),
      h("div", { class: "kv" }, h("span", { class: "k small muted", text: "Verify endpoint" }), h("span", { class: "mono", text: me.verify_url }), copyBtn(me.verify_url)),
      h("p", { class: "small", style: "margin:18px 0 0;font-weight:600", text: "Request" }), h("pre", { class: "code mono", text: curl }),
      h("p", { class: "small", style: "margin:18px 0 0;font-weight:600", text: "Response" }), h("pre", { class: "code mono", text: resp }),
      h("p", { class: "small", style: "margin:18px 0 0;font-weight:600", text: "Report an outcome" }), h("pre", { class: "code mono", text: outcome }),
      h("p", { class: "small muted", style: "margin:18px 0 0", text: "Using Lead Prosper? Add verify as a pre-ping webhook on your campaign and map the vs_ fields; send outcomes from Sold and Unsold triggers to your outcome URL. Ask us and we'll set it up with you." }));
  }

  render();
})();
`;
