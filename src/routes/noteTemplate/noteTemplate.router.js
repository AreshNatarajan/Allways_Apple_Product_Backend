import express from 'express';
const router = express.Router();

import authMiddleware from '../../middleware/authMiddleware.js';
import requirePermission from '../../middleware/requirePermission.js';

import { createNoteTemplateController } from '../../controllers/noteTemplate/createNoteTemplate.controller.js';
import { getNoteTemplatesController } from '../../controllers/noteTemplate/getNoteTemplates.controller.js';
import { deleteNoteTemplateController } from '../../controllers/noteTemplate/deleteNoteTemplate.controller.js';

// Read is open to any authenticated role. Create/delete are gated by
// the per-user permission system (requirePermission) - SUPER_ADMIN
// always passes, BRANCH_ADMIN/STAFF need the matching noteTemplate.*
// grant, which defaults to true for both today (matching the old
// localStorage version's behavior where anyone using that browser
// could add/remove a template) but can be individually revoked.
router.get('/', authMiddleware, getNoteTemplatesController);
router.post('/', authMiddleware, requirePermission('noteTemplate.create'), createNoteTemplateController);
router.delete('/:id', authMiddleware, requirePermission('noteTemplate.delete'), deleteNoteTemplateController);

export default router;
