import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import leadScoringRouter from "./lead_scoring.js";
import scoreAndRouteRouter from "./score_and_route.js";
import leadProsperRouter from "./leadprosper.js";
import leadProsperOutcomeRouter from "./leadprosper_outcome.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use(leadScoringRouter);
router.use(scoreAndRouteRouter);
router.use(leadProsperRouter);
router.use(leadProsperOutcomeRouter);

export default router;
