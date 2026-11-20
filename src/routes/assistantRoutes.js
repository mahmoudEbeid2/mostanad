import express from "express";
import { protect, restrictToPermission } from "../middleware/authMiddleware.js";
import { validate } from "../middleware/validateMiddleware.js";
import { assistantSchemas as s } from "../validators/assistantValidator.js";
import * as c from "../controllers/assistantController.js";

// In-app assistant (C0/C1). Conversation routes are open to every signed-in
// caller whose assistant switch is on (checked in the service), with no
// permission of their own on purpose: the assistant has no access of its own —
// every tool it runs checks the caller's own permissions, as the screens do.
// The switch and limits are system-admin only (manage_assistant_settings; its
// module is not in COMPANY_ALLOWED_MODULES, so no company token passes).
const router = express.Router();
router.use(protect);

router.get("/status", c.status);
router.post("/conversations", validate(s.create), c.createConversation);
router.get("/conversations", c.listConversations);
router.get("/conversations/:id", validate(s.byId), c.getConversation);
router.delete("/conversations/:id", validate(s.byId), c.deleteConversation);
router.post("/conversations/:id/messages", validate(s.message), c.postMessage);
router.post("/conversations/:id/messages/:messageId/blocks/:blockId/more", validate(s.more), c.loadMore);

router.get("/settings", restrictToPermission("manage_assistant_settings"), c.listSettings);
router.patch("/settings/:scopeKey", restrictToPermission("manage_assistant_settings"), validate(s.settings), c.updateSettings);

export default router;
