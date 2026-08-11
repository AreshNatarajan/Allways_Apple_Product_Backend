import {
    successResponse,
    errorResponse,
} from "../../utils/responseHandler.js";

export const uploadSignatureController =
    async (
        req,
        res
    ) => {

        try {

            if (!req.file) {

                return errorResponse(
                    res,
                    "Signature image is required",
                    400
                );

            }

            return successResponse(
                res,
                "Signature uploaded successfully",
                {
                    signature:
                        `/uploads/signatures/${req.file.filename}`,
                    fileName:
                        req.file.filename,
                }
            );

        } catch (error) {

            console.error(
                "Signature Upload Error:",
                error
            );

            return errorResponse(
                res,
                "Signature upload failed",
                500
            );

        }

    };