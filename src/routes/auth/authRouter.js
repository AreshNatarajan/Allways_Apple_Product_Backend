import express from "express";
const router = express.Router();

// 1. Change the requires to modern imports
import { registerController } from '../../controllers/auth/registerController.js';
import { loginController } from '../../controllers/auth/loginController.js';
import { logoutController } from '../../controllers/auth/logoutController.js';
import authMiddleware from '../../middleware/authMiddleware.js';

router.post('/register', registerController);
router.post('/login', loginController);
router.post('/logout', authMiddleware, logoutController);


export default router;