// The lead's own details, as Lead Prosper sends them in the pre-ping body.
// Plausibility checks read these at scoring time only: the raw values are not
// copied into findings, evidence or logs, and names are dropped before the
// request is stored (see storable_payload).

export interface LeadFields {
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  state: string | null; // two-letter code
  valid_phone: boolean | null; // Lead Prosper's own phone validation
}

function str(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  // An unfilled Lead Prosper placeholder ("{{first_name}}") is not a value.
  return t && !t.includes("{{") ? t : null;
}

function bool(v: unknown): boolean | null {
  if (typeof v === "boolean") return v;
  const t = str(v)?.toLowerCase();
  if (t === "true" || t === "yes" || t === "1") return true;
  if (t === "false" || t === "no" || t === "0") return false;
  return null;
}

export const US_STATES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California",
  CO: "Colorado", CT: "Connecticut", DE: "Delaware", DC: "District of Columbia",
  FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois",
  IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana",
  ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota",
  MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada",
  NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York",
  NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon",
  PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota",
  TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia",
  WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
};

const STATE_BY_NAME: Record<string, string> = Object.fromEntries(
  Object.entries(US_STATES).map(([code, name]) => [name.toLowerCase(), code]),
);

// "PA", "pa", "Pennsylvania" → "PA". Anything else → null.
export function to_state_code(v: unknown): string | null {
  const t = str(v);
  if (!t) return null;
  const up = t.toUpperCase();
  if (US_STATES[up]) return up;
  return STATE_BY_NAME[t.toLowerCase()] ?? null;
}

export function read_lead_fields(payload: Record<string, unknown> | null | undefined): LeadFields {
  const p = payload ?? {};
  return {
    first_name: str(p["first_name"]),
    last_name: str(p["last_name"]),
    email: str(p["email"]),
    phone: str(p["phone"]),
    state: to_state_code(p["state"]),
    valid_phone: bool(p["valid_phone"]),
  };
}

// Names are needed to score a lead, not to keep one. Email and phone stay,
// because certificate-reuse detection compares them with later requests.
const NOT_STORED = ["first_name", "last_name", "full_name", "address", "address2", "street"];

export function storable_payload(payload: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(payload ?? {}) };
  for (const key of NOT_STORED) delete out[key];
  return out;
}
