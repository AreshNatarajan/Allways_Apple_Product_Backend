import express from 'express';
const router = express.Router();

import authMiddleware from '../../middleware/authMiddleware.js';


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

router.patch(
    "/update-status/:id",
    authMiddleware,
    updatePurchasedProductStatusController
);


export default router;