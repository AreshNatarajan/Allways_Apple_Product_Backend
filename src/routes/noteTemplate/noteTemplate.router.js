import express from 'express';
const router = express.Router();

import authMiddleware from '../../middleware/authMiddleware.js';

import { createNoteTemplateController } from '../../controllers/noteTemplate/createNoteTemplate.controller.js';
import { getNoteTemplatesController } from '../../controllers/noteTemplate/getNoteTemplates.controller.js';
import { deleteNoteTemplateController } from '../../controllers/noteTemplate/deleteNoteTemplate.controller.js';

// Any authenticated role (whoever can create a Purchase/Sale can manage
// its note-template chips) - not gated to admins, matching the old
// localStorage version's behavior where anyone using that browser could
// add/remove a template.
router.get('/', authMiddleware, getNoteTemplatesController);
router.post('/', authMiddleware, createNoteTemplateController);
router.delete('/:id', authMiddleware, deleteNoteTemplateController);

export default router;
