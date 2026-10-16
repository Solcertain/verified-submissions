import * as R from "../config/authenticity_rules.js";
import { NONE, type Detector } from "./types.js";

// Desktop Linux on an IP that geolocates only to a country: the shape of a
// cloud-hosted browser. Requires that geo came back at all, so a certificate
// with no insights is never mistaken for one with an imprecise IP.
export const automation_environment: Detector = {
  id: "automation_environment",
  family: "environment",
  status: "active",
  description: "A device and network combination typical of cloud-hosted browsers.",
  evaluate({ features: f }) {
    if (!(f.os_name === "Linux" && f.is_mobile === false && f.geo_country_code !== null && f.geo_state === null)) {
      return NONE;
    }
    return {
      findings: [
        {
          points: -R.AUTOMATION_ENVIRONMENT,
          flag: "automation_environment",
          evidence:
            "Desktop Linux on an IP that locates only to a country — typical of a cloud-hosted browser, rare for consumers.",
        },
      ],
    };
  },
};
