import { Router, type Request, type Response } from "express";
import { PORTAL_CSS, PORTAL_HTML, PORTAL_JS, PORTAL_THEME_JS } from "../portal/assets.js";
import { LOGO_DARK, LOGO_LIGHT, MARK_LIGHT } from "../portal/brand.js";

// Serves the customer portal at /portal (mounted in app.ts). Every page path
// gets the same shell; the script picks the view from the URL.

const router = Router();

// Geist comes from Google Fonts, as on verifiedsubmission.com; everything else
// is served from here.
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

function secure_headers(res: Response): void {
  res.set({
    "Content-Security-Policy": CSP,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
  });
}

function asset(type: string, body: string, cache = "no-cache") {
  return (_req: Request, res: Response) => {
    secure_headers(res);
    res.type(type).set("Cache-Control", cache).send(body);
  };
}

router.get("/app.js", asset("application/javascript", PORTAL_JS));
router.get("/theme.js", asset("application/javascript", PORTAL_THEME_JS));
router.get("/app.css", asset("text/css", PORTAL_CSS));
router.get("/brand/logo-light.svg", asset("image/svg+xml", LOGO_LIGHT, "public, max-age=86400"));
router.get("/brand/logo-dark.svg", asset("image/svg+xml", LOGO_DARK, "public, max-age=86400"));
router.get("/brand/mark.svg", asset("image/svg+xml", MARK_LIGHT, "public, max-age=86400"));

// The shell for /portal and every view under it. no-store, because a set-
// password link carries its token in the query string.
router.get(["/", "/*path"], (_req: Request, res: Response) => {
  secure_headers(res);
  res.type("html").set("Cache-Control", "no-store").send(PORTAL_HTML);
});

export default router;
