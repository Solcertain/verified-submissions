// The repeatable verification report: what the engine saw, what it decided,
// and what happened to the leads afterwards. Pure — the rows come from
// report_store — so the same numbers can be rebuilt and tested.
//
// Only aggregates and ids leave this module. No name, email, phone or address
// is ever read here.

export interface ReportSubmission {
  id: string;
  received_at: Date;
  score: number | null;
  status: string | null;
  classification: string | null;
  model_version: string | null; // null = scored by the legacy model
  consent_verdict: string | null;
  risk_flags: string[];
  shadow_flags: string[];
  source: string; // lead_source when sent, else the certificate's site
  is_mobile: boolean | null;
}

export interface ReportOutcome {
  analysis_id: string | null;
  outcome: string | null; // sold | unsold | returned
  return_category: string | null;
}

const BANDS: [string, number, number][] = [
  ["90–98", 90, 100],
  ["80–89", 80, 89],
  ["62–79", 62, 79],
  ["39–61", 39, 61],
  ["0–38", 0, 38],
];

const VERIFICATION_RETURNS = new Set(["fraud", "contact_invalid", "consent_dispute"]);

function count<T>(items: T[], key: (t: T) => string | null | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) {
    const k = key(item);
    if (k) out[k] = (out[k] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1]));
}

function count_all(items: string[][]): Record<string, number> {
  return count(items.flat(), (x) => x);
}

function pct(n: number, d: number): string {
  return d === 0 ? "—" : `${Math.round((100 * n) / d)}%`;
}

export interface VerificationReport {
  period: { start: string; end: string; days: number };
  leads: {
    scored: number;
    current_model: number;
    legacy_model: number;
    by_status: Record<string, number>;
    by_classification: Record<string, number>;
    by_score_band: Record<string, number>;
    by_source: Record<string, number>;
    consent_verified: number;
    mobile: number;
  };
  risk_flags: Record<string, number>;
  shadow_flags: Record<string, number>;
  outcomes: {
    linked_leads: number;
    sold: number;
    unsold: number;
    returned: number;
    returns_by_category: Record<string, number>;
    verification_returns: number;
    // Of leads that sold, how many came back for a verification reason, by the
    // score they had when sold. This is the calibration readout.
    verification_return_rate_by_band: Record<string, { sold: number; verification_returns: number }>;
  };
  // Leads the engine held back, for a person to look at. Ids only.
  held_back: { id: string; score: number | null; status: string | null; flags: string[] }[];
  markdown: string;
}

export function build_report(
  subs: ReportSubmission[],
  outcomes: ReportOutcome[],
  period: { start: Date; end: Date },
): VerificationReport {
  const current = subs.filter((s) => s.model_version !== null);
  const band_of = (score: number | null) =>
    score === null ? null : (BANDS.find(([, lo, hi]) => score >= lo && score <= hi)?.[0] ?? null);

  const by_analysis = new Map<string, ReportOutcome[]>();
  for (const o of outcomes) {
    if (!o.analysis_id) continue;
    const list = by_analysis.get(o.analysis_id) ?? [];
    list.push(o);
    by_analysis.set(o.analysis_id, list);
  }
  const in_window = new Set(subs.map((s) => s.id));
  const linked = [...by_analysis.keys()].filter((id) => in_window.has(id));

  const returned_rows = outcomes.filter((o) => o.outcome === "returned" && o.analysis_id && in_window.has(o.analysis_id));

  const rate: VerificationReport["outcomes"]["verification_return_rate_by_band"] = {};
  for (const [band] of BANDS) rate[band] = { sold: 0, verification_returns: 0 };
  for (const s of current) {
    const outs = by_analysis.get(s.id) ?? [];
    const sold = outs.some((o) => o.outcome === "sold" || o.outcome === "returned");
    const band = band_of(s.score);
    if (!sold || !band) continue;
    rate[band]!.sold++;
    if (outs.some((o) => o.outcome === "returned" && VERIFICATION_RETURNS.has(o.return_category ?? ""))) {
      rate[band]!.verification_returns++;
    }
  }

  const held_back = current
    .filter((s) => s.status === "review" || s.status === "reject")
    .map((s) => ({ id: s.id, score: s.score, status: s.status, flags: s.risk_flags }));

  const days = Math.max(1, Math.round((period.end.getTime() - period.start.getTime()) / 86_400_000));

  const report: Omit<VerificationReport, "markdown"> = {
    period: { start: period.start.toISOString().slice(0, 10), end: period.end.toISOString().slice(0, 10), days },
    leads: {
      scored: subs.length,
      current_model: current.length,
      legacy_model: subs.length - current.length,
      by_status: count(current, (s) => s.status),
      by_classification: count(current, (s) => s.classification),
      by_score_band: count(current, (s) => band_of(s.score)),
      by_source: count(subs, (s) => s.source),
      consent_verified: current.filter((s) => s.consent_verdict === "VERIFIED").length,
      mobile: current.filter((s) => s.is_mobile === true).length,
    },
    risk_flags: count_all(current.map((s) => s.risk_flags)),
    shadow_flags: count_all(current.map((s) => s.shadow_flags)),
    outcomes: {
      linked_leads: linked.length,
      sold: linked.filter((id) => by_analysis.get(id)!.some((o) => o.outcome === "sold")).length,
      unsold: linked.filter((id) => by_analysis.get(id)!.some((o) => o.outcome === "unsold")).length,
      returned: returned_rows.length,
      returns_by_category: count(returned_rows, (o) => o.return_category),
      verification_returns: returned_rows.filter((o) => VERIFICATION_RETURNS.has(o.return_category ?? "")).length,
      verification_return_rate_by_band: rate,
    },
    held_back,
  };

  return { ...report, markdown: to_markdown(report) };
}

const FLAG_MEANING: Record<string, string> = {
  synthetic_typing: "text entered with no keystrokes — a person cannot type without pressing keys",
  automation_environment: "a desktop Linux machine on an imprecise IP — the shape of a cloud-hosted browser",
  superhuman_typing_speed: "typing faster than any person sustains",
  stale_certificate: "consent captured long before the lead was sold",
  certificate_reused: "one consent certificate attached to more than one lead",
  certificate_page_mismatch: "consent captured on a different website than the lead claims",
  consent_language_missing: "the disclosure lacks the required TCPA phrasing",
  bot_detected: "TrustedForm's own bot check failed",
  no_typing_observed: "the form was filled without any typing",
  pasted_input: "at least one field was pasted",
  instant_submission: "submitted too fast to have been read",
  brief_session: "a very short session",
  placeholder_name: "a placeholder or test name",
  disposable_email: "a throwaway email address",
  ip_state_mismatch: "a home or office connection in a different state from the address",
  phone_unverified: "Lead Prosper's phone validation failed",
};

function table(rows: [string, string | number][], head: [string, string]): string {
  if (rows.length === 0) return "_None._\n";
  return [`| ${head[0]} | ${head[1]} |`, "|---|---|", ...rows.map(([a, b]) => `| ${a} | ${b} |`)].join("\n") + "\n";
}

function to_markdown(r: Omit<VerificationReport, "markdown">): string {
  const L = r.leads;
  const approved = L.by_status["approved"] ?? 0;
  const review = L.by_status["review"] ?? 0;
  const reject = L.by_status["reject"] ?? 0;
  const flag_rows = Object.entries(r.risk_flags).map(
    ([f, n]) => [`\`${f}\` — ${FLAG_MEANING[f] ?? ""}`, `${n} (${pct(n, L.current_model)})`] as [string, string],
  );
  const shadow_rows = Object.entries(r.shadow_flags).map(
    ([f, n]) => [`\`${f}\` — ${FLAG_MEANING[f] ?? ""}`, `${n} (${pct(n, L.current_model)})`] as [string, string],
  );
  const band_rows = Object.entries(r.outcomes.verification_return_rate_by_band)
    .filter(([, v]) => v.sold > 0)
    .map(([b, v]) => [b, `${v.verification_returns} of ${v.sold} sold (${pct(v.verification_returns, v.sold)})`] as [string, string]);

  return `# Verification report — ${r.period.start} to ${r.period.end}

## Headline
- **${L.scored} leads scored** (${L.current_model} on the current model${L.legacy_model ? `, ${L.legacy_model} legacy` : ""}).
- **${approved} approved, ${review} sent to review, ${reject} rejected** — ${pct(review + reject, L.current_model)} held back.
- **Consent verified on ${L.consent_verified} (${pct(L.consent_verified, L.current_model)})** — the disclosure matched the approved language on file.
- **${r.outcomes.returned} returns**, of which **${r.outcomes.verification_returns}** were verification problems (fraud, bad contact, consent); the rest were territory and fit.

## Where leads came from
${table(Object.entries(L.by_source), ["Source", "Leads"])}
${L.mobile} of ${L.current_model} on phones.

## Scores
${table(Object.entries(L.by_score_band), ["Score band", "Leads"])}
## What the engine caught
Each flag, and why it matters:

${table(flag_rows, ["Finding", "Leads"])}
## Checks being measured (shadow — no effect on any lead yet)
${table(shadow_rows, ["Finding", "Leads"])}
## What happened afterwards
- ${r.outcomes.linked_leads} leads have a recorded outcome: ${r.outcomes.sold} sold, ${r.outcomes.unsold} unsold, ${r.outcomes.returned} returned.

${table(Object.entries(r.outcomes.returns_by_category), ["Return reason", "Count"])}
### Verification returns by score at sale
${band_rows.length ? table(band_rows, ["Score band", "Came back for a verification reason"]) : "_Not enough sold leads with outcomes yet._\n"}
## Held back for review
${r.held_back.length ? r.held_back.map((h) => `- \`${h.id.slice(0, 8)}\` — ${h.score} ${h.status}${h.flags.length ? `: ${h.flags.join(", ")}` : ""}`).join("\n") : "_None._"}
`;
}
