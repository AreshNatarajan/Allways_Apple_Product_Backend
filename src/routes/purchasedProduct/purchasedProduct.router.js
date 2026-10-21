import express from 'express';
const router = express.Router();

import authMiddleware from '../../middleware/authMiddleware.js';
import onlySuperAdmin from '../../middleware/onlySuperAdmin.js';


import { getAllPurchasedProductsController } from '../../controllers/purchasedProduct/getAllPurchasedProducts.controller.js'
import { getPurchasedProductStatsController } from '../../controllers/purchasedProduct/getPurchasedProductStats.controller.js'
import { updatePurchasedProductStatusController } from '../../controllers/purchasedProduct/updatePurchasedProductStatus.controller.js'
// router.get('/', authMiddleware, getAllPurchasedProductsController)


router.get(
    '/pagination',
    authMiddleware,
    getAllPurchasedProductsController
);

router.get(
    "/stats",
    authMiddleware,
    getPurchasedProductStatsController
);

// Sets a unit's status directly (no stock movement, no history) - the
// screen that used it is gone. Was open to every logged-in user on every
// branch's units; now SUPER_ADMIN only. Branch users change stock only
// through sale / return / exchange / transfer, which record it properly.
router.patch(
    "/update-status/:id",
    authMiddleware,
    onlySuperAdmin,
    updatePurchasedProductStatusController
);


export default router;