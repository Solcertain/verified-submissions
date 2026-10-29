// Where the customer portal lives, for links in emails, set-password links and
// Checkout return URLs. The portal is served by this API at /portal, so it
// works on the API's own address until portal.verifiedsubmission.com is set
// up; PORTAL_URL overrides it.
export function portal_base(): string {
  return (process.env["PORTAL_URL"] ?? "https://verified-submissions-api.vercel.app/portal").replace(/\/$/, "");
}
