import * as R from "../config/authenticity_rules.js";
import { to_state_code } from "../services/lead_fields.js";
import { NONE, type Detector } from "./types.js";

// Plausibility: does the person described by the lead look real? Five of the
// six verification returns backtested on 2026-10-17 behaved like humans on the
// form; what gave them away was the lead's own details (a "First Last" name, a
// phone number that belonged to a gym). These checks read those details.
//
// All start in shadow: the human baseline carries no lead fields, so their
// false-positive rate on real customers is unknown until live traffic shows it.
// Evidence never repeats the name, email or phone — findings reach the logs.

const PLACEHOLDER_NAMES = new Set([
  "first", "last", "firstname", "lastname", "fname", "lname", "name", "fullname",
  "test", "testing", "tester", "fake", "sample", "demo", "dummy", "example",
  "asdf", "asdfg", "asdfgh", "qwerty", "qwer", "zxcv", "abc", "abcd", "abcde",
  // Not "na" or "nil": both are real names (Korean surname Na, Turkish given name Nil).
  "xxx", "xxxx", "none", "null", "unknown", "user", "customer",
  "noname", "nobody", "anonymous",
]);
const PLACEHOLDER_PAIRS = new Set(["john doe", "jane doe", "first last", "test test", "test user"]);

function letters(s: string): string {
  return s.toLowerCase().replace(/[^a-z]/g, "");
}

// Why one name part looks fake, or null if it looks like a name.
function name_problem(raw: string | null): string | null {
  if (raw === null) return null;
  if (/\d/.test(raw)) return "digits";
  const n = letters(raw);
  if (n.length === 0) return "no letters";
  if (PLACEHOLDER_NAMES.has(n)) return "placeholder";
  if (/^(.)\1{2,}$/.test(n)) return "repeated letter";
  // Keyboard mashing ("sdfgh", "hjkl"): four or more letters and no vowel.
  if (n.length >= 4 && !/[aeiouy]/.test(n)) return "no vowels";
  return null;
}

export const placeholder_name: Detector = {
  id: "placeholder_name",
  family: "plausibility",
  status: "shadow",
  description: "A name that is a placeholder, test entry or keyboard mash rather than a person's name.",
  evaluate({ options }) {
    const lead = options.lead;
    if (!lead || (lead.first_name === null && lead.last_name === null)) return NONE;
    const first = lead.first_name;
    const last = lead.last_name;
    const pair = `${letters(first ?? "")} ${letters(last ?? "")}`;
    const same = first !== null && last !== null && letters(first).length > 1 && letters(first) === letters(last);
    const fake =
      PLACEHOLDER_PAIRS.has(pair) || same || name_problem(first) !== null || name_problem(last) !== null;
    if (!fake) return NONE;
    return {
      findings: [
        {
          points: -R.PLACEHOLDER_NAME,
          flag: "placeholder_name",
          evidence: "The name looks like a placeholder or test entry rather than a real person's name.",
        },
      ],
    };
  },
};

// Throwaway inboxes and obvious non-addresses.
const DISPOSABLE_DOMAINS = new Set([
  "mailinator.com", "guerrillamail.com", "guerrillamail.net", "sharklasers.com", "grr.la",
  "10minutemail.com", "10minutemail.net", "tempmail.com", "temp-mail.org", "tempmail.net",
  "yopmail.com", "yopmail.net", "trashmail.com", "trashmail.net", "getnada.com", "nada.email",
  "maildrop.cc", "dispostable.com", "throwawaymail.com", "fakeinbox.com", "mintemail.com",
  "mohmal.com", "emailondeck.com", "burnermail.io", "mailnesia.com", "spamgourmet.com",
  "tempinbox.com", "discard.email", "mailcatch.com", "inboxkitten.com",
  "example.com", "example.org", "example.net", "test.com", "test.org", "fake.com",
  "noemail.com", "none.com", "email.test",
]);
const PLACEHOLDER_LOCALS = new Set(["test", "testing", "fake", "asdf", "noemail", "none", "na", "null", "abc", "xxx", "no"]);

export const disposable_email: Detector = {
  id: "disposable_email",
  family: "plausibility",
  status: "shadow",
  description: "An email address on a throwaway inbox service, or an obvious non-address.",
  evaluate({ options }) {
    const email = options.lead?.email?.toLowerCase() ?? null;
    if (!email || !email.includes("@")) return NONE;
    const [local, domain] = [email.slice(0, email.lastIndexOf("@")), email.slice(email.lastIndexOf("@") + 1)];
    if (!DISPOSABLE_DOMAINS.has(domain) && !PLACEHOLDER_LOCALS.has(letters(local))) return NONE;
    return {
      findings: [
        {
          points: -R.DISPOSABLE_EMAIL,
          flag: "disposable_email",
          evidence: "The email address is a throwaway inbox or a placeholder, not one a person would keep.",
        },
      ],
    };
  },
};

// The IP's state against the lead's state. Weak alone — mobile carriers route
// through hub cities and people travel — so it is measured in shadow before it
// is allowed to count.
export const ip_state_mismatch: Detector = {
  id: "ip_state_mismatch",
  family: "plausibility",
  status: "shadow",
  description: "The device's IP address locates to a different state than the lead's address.",
  evaluate({ features: f, options }) {
    const lead_state = options.lead?.state ?? null;
    const ip_state = to_state_code(f.geo_state);
    if (!lead_state || !ip_state || lead_state === ip_state) return NONE;
    return {
      findings: [
        {
          points: -R.IP_STATE_MISMATCH,
          flag: "ip_state_mismatch",
          evidence: "The device's IP address locates to a different state than the lead's address.",
        },
      ],
    };
  },
};

// Lead Prosper's own phone validation. Recorded, not trusted: in the Oct 2026
// sample 14 of 19 leads it marked invalid were sold and none were returned.
export const phone_unverified: Detector = {
  id: "phone_unverified",
  family: "plausibility",
  status: "shadow",
  description: "Lead Prosper's phone validation marked the number as not valid.",
  evaluate({ options }) {
    if (options.lead?.valid_phone !== false) return NONE;
    return {
      findings: [
        {
          points: -R.PHONE_UNVERIFIED,
          flag: "phone_unverified",
          evidence: "Lead Prosper's phone validation marked this number as not valid.",
        },
      ],
    };
  },
};
