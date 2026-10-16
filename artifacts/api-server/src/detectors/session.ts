import * as R from "../config/authenticity_rules.js";
import { NONE, type Detector, type Finding } from "./types.js";

// Time on page. Too fast to have been read costs points; a sustained session
// earns them on a ramp so longer genuine sessions keep scoring higher.
export const session_duration: Detector = {
  id: "session_duration",
  family: "session",
  status: "active",
  description: "How long the person spent on the form.",
  evaluate({ features: f }) {
    const secs = f.seconds_on_page;
    if (secs === null) return NONE;
    let finding: Finding | null = null;
    if (secs < R.INSTANT_SESSION_SECONDS) {
      finding = {
        points: -R.INSTANT_SESSION,
        flag: "instant_submission",
        evidence: `Submitted after only ${secs}s — too fast to have been read.`,
      };
    } else if (secs < R.BRIEF_SESSION_SECONDS) {
      finding = { points: -R.BRIEF_SESSION, flag: "brief_session", evidence: `Brief ${secs}s session.` };
    } else if (secs >= R.SUSTAINED_SESSION_SECONDS) {
      const ramp = Math.min(
        1,
        (secs - R.SUSTAINED_SESSION_SECONDS) / (R.LONG_SESSION_SECONDS - R.SUSTAINED_SESSION_SECONDS),
      );
      finding = {
        points: R.SUSTAINED_SESSION + ramp * (R.SUSTAINED_SESSION_MAX - R.SUSTAINED_SESSION),
        evidence: `Sustained ${secs}s session.`,
      };
    } else if (secs >= R.MODERATE_SESSION_SECONDS) {
      finding = { points: R.MODERATE_SESSION, evidence: `${secs}s session.` };
    }
    return { signals: 1, findings: finding ? [finding] : [] };
  },
};
