import type { IncomingMessage, ServerResponse } from "node:http";
import express, { type Express, type Request, type Response } from "express";
import cors from "cors";
import { pinoHttp } from "pino-http";
import router from "./routes/index.js";
import { stripe_webhook } from "./routes/billing.js";
import portalPages from "./routes/portal_pages.js";
import { logger } from "./lib/logger.js";

type PinoRequest = IncomingMessage & { id?: unknown };

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req: PinoRequest) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res: ServerResponse) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
// Before express.json(): Stripe's signature covers the raw bytes it sent.
app.post("/api/stripe/webhook", express.raw({ type: "*/*", limit: "1mb" }), stripe_webhook);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get("/", (_req: Request, res: Response) => {
  res.redirect("/api/healthz");
});

app.use("/api", router);
app.use("/portal", portalPages);

export default app;
