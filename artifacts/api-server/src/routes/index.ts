import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import leadScoringRouter from "./lead_scoring.js";
import scoreAndRouteRouter from "./score_and_route.js";
import leadProsperRouter from "./leadprosper.js";
import leadProsperOutcomeRouter from "./leadprosper_outcome.js";
import cronRouter from "./cron.js";
import reportsRouter from "./reports.js";
import outcomeLabelsRouter from "./outcome_labels.js";
import v1Router from "./v1.js";
import billingRouter from "./billing.js";
import adminRouter from "./admin.js";
import portalRouter from "./portal.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use(leadScoringRouter);
router.use(scoreAndRouteRouter);
router.use(leadProsperRouter);
router.use(leadProsperOutcomeRouter);
router.use(cronRouter);
router.use(reportsRouter);
router.use(outcomeLabelsRouter);
router.use(v1Router);
router.use(billingRouter);
router.use(adminRouter);
router.use(portalRouter);

export default router;
