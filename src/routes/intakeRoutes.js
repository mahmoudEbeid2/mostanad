import express from "express";
import { protect, restrictToPermission } from "../middleware/authMiddleware.js";
import * as c from "../controllers/intakeController.js";
import { CHUNK_BYTES } from "../services/intake/intakeService.js";

// Auto-intake: drop any files → recognised, reviewed on one card, filed on "نفّذ الكل".
// Files come in chunks (resumable, up to 60 MB each, a .zip up to 250 MB).
const router = express.Router();
router.use(protect, restrictToPermission("read_products"));

router.get("/batches", c.listBatches);
router.post("/batches", c.createBatch);
router.get("/batches/:id", c.getBatch);
router.post("/batches/:id/files", c.addFile);
router.put("/items/:itemId/chunk", express.raw({ type: "application/octet-stream", limit: CHUNK_BYTES + 1024 }), c.putChunk);
router.post("/batches/:id/classify", c.startClassify);
router.patch("/items/:itemId", c.decideItem);
router.post("/batches/:id/execute", c.execute);
router.get("/created", c.listCreated);
router.get("/express", c.listExpress);
router.post("/express/reviewed", c.markExpressReviewed);
router.post("/batches/:id/express/templates-from-files", c.makeExpressTemplates);

export default router;
