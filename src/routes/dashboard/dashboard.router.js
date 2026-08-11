import express from "express";

const router = express.Router();

import authMiddleware from "../../middleware/authMiddleware.js";


import { getDashboardController } from '../../controllers/dashboard/getDashboard.controller.js'

router.get('/stats', authMiddleware,  getDashboardController);

export default router;