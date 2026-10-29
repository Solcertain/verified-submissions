import { Router, type Request, type Response } from "express";
import { PORTAL_CSS, PORTAL_HTML, PORTAL_JS } from "../portal/assets.js";

// Serves the customer portal at /portal (mounted in app.ts). Every page path
// gets the same shell; the script picks the view from the URL.

const router = Router();

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
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

router.get("/app.js", (_req: Request, res: Response) => {
  secure_headers(res);
  res.type("application/javascript").set("Cache-Control", "no-cache").send(PORTAL_JS);
});

router.get("/app.css", (_req: Request, res: Response) => {
  secure_headers(res);
  res.type("text/css").set("Cache-Control", "no-cache").send(PORTAL_CSS);
});

// The shell for /portal and every view under it. no-store, because a set-
// password link carries its token in the query string.
router.get(["/", "/*path"], (_req: Request, res: Response) => {
  secure_headers(res);
  res.type("html").set("Cache-Control", "no-store").send(PORTAL_HTML);
});

export default router;
