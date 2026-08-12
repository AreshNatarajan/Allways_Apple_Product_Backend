import "dotenv/config";

import dns from "node:dns";
dns.setServers(["1.1.1.1", "8.8.8.8"]);


import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import connectDB from "./config/db.js";
import path from "path";
import fileUpload from "express-fileupload";

// dotenv.config();


/////

const app = express();

// Trust the first proxy hop (e.g. Render) so req.ip / X-Forwarded-For
// reflect the real client IP instead of the proxy's address.
app.set('trust proxy', 1);

const allowedOrigins = [
    "http://localhost:5173",
    "http://localhost:5174",
    "https://shopping-frontend-c82v.onrender.com",
    "https://allways-apple-product-backend.onrender.com"
];

app.use(cors({
    origin: allowedOrigins,
    credentials: true
}));



// Database Connection
connectDB();

// Middlewares
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(fileUpload());


import authMiddleware from "./middleware/authMiddleware.js";

// Routes

import authRouter from "./routes/auth/authRouter.js";

import productRouter from "./routes/product/product.router.js";
import productSerialRouter from "./routes/productSerial/productSerial.router.js";
import whatsappRouter from "./routes/whatsapp/whatsapp.router.js";
import inventoryRouter from "./routes/inventory/inventory.router.js";
import purchaseRouter from "./routes/purchase/purchase.router.js";
import saleRouter from "./routes/sale/sale.router.js";
import vendorRouter from "./routes/vendor/vendor.router.js";
import customerRouter from "./routes/customer/customer.router.js";
import gstConfigRouter from "./routes/gstConfig/gstConfig.router.js";
import purchasedProductRouter from './routes/purchasedProduct/purchasedProduct.router.js'
import dashboardRouter from './routes/dashboard/dashboard.router.js'
import branchRouter from './routes/branch/branch.router.js'
import reportsRouter from './routes/reports/reports.router.js'
import PendingReceiveRouter from "./routes/pendingReceives/pendingReceives.router.js";
// import branchDropdown from './routes/branch/branchDropdown.router.js'

import PendingHistory from './routes/pendingReceivesHistory/pendingReceivesHistory.router.js'


import transferRouter from './routes/transfer/transfer.router.js'


import userRouter from "./routes/users/user.router.js";

app.use(
    "/uploads",
    express.static(
        path.join(
            process.cwd(),
            "src/uploads"
        )
    )
);



console.log("SERVER FILE LOADED");

console.log("AWS REGION:", process.env.AWS_REGION);
console.log(
    "ACCESS KEY:",
    process.env.AWS_ACCESS_KEY_ID
        ? "Loaded"
        : "Missing"
);
console.log(
    "SECRET KEY:",
    process.env.AWS_SECRET_ACCESS_KEY
        ? "Loaded"
        : "Missing"
);
console.log(
    "BUCKET:",
    process.env.AWS_S3_BUCKET_NAME
);

app.get("/", (req, res) => {
    res.send("API Running...");
});

// Test Route
app.get("/", authMiddleware, (req, res) => {
    res.send("API Running...");
});

app.get("/isrunning", authMiddleware, (req, res) => {
    res.send("API Running...");
});


// all paths

app.use("/api/auth", authRouter);
app.use("/api/product", productRouter);
app.use("/api/product-serial", productSerialRouter);
app.use("/api/whatsapp", whatsappRouter);
app.use("/api/inventory", inventoryRouter);
app.use("/api/purchase", purchaseRouter);
app.use("/api/sale", saleRouter);
app.use("/api/vendor", vendorRouter);
app.use("/api/customer", customerRouter);
app.use("/api/gst-config", gstConfigRouter);
app.use('/api/purchased-product', purchasedProductRouter)
app.use('/api/dashboard', dashboardRouter)
app.use('/api/PendingReceive' , PendingReceiveRouter);

app.use('/api/receive-history', PendingHistory);

app.use('/api/transfers', transferRouter);

app.use('/api/user', userRouter);


console.log('Branch routes imported successfully');
app.use('/api/branch', branchRouter)
console.log('Branch routes mounted at /api/branch');
app.use('/api/reports', reportsRouter);

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
    console.log(`Server running on port http://localhost:${PORT}`);
});