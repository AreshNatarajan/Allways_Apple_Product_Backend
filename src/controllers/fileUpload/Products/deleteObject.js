import { DeleteObjectCommand } from "@aws-sdk/client-s3";
import s3 from "../../../config/s3.js";

// Paused for now - the AWS account is in quarantine (a credential got
// exposed) and S3 delete calls are failing/blocked because of it. Every
// image/attachment delete in this app funnels through this one helper
// (Product/ProductSerial/Service staging images, Vendor attachments,
// Branch logo/UPI QR, profile photos, GST invoice signature - grep
// finds no other place that ever calls S3 DeleteObject), so gating it
// here is the ONE switch to flip back to true once the quarantine is
// cleared and deletes work again - nothing else needs to change. Until
// then, the real object is left behind in S3 (orphaned, not deleted)
// and every caller proceeds exactly as if the delete succeeded - they
// still remove their own DB reference/array entry, which is what
// actually makes the image disappear from the app.
const S3_DELETE_ENABLED = false;

export const deleteObject = async (key) => {
    if (!S3_DELETE_ENABLED) {
        console.warn(`S3 delete skipped (quarantine workaround) - object left orphaned in S3: ${key}`);
        return {
            key,
            deleted: false,
            skipped: true,
        };
    }

    const command = new DeleteObjectCommand({
        Bucket: process.env.AWS_S3_BUCKET_NAME,
        Key: key,
    });

    const data = await s3.send(command);

    console.log("S3 delete:", data.$metadata.httpStatusCode);

    return {
        key,
        deleted: true,
    };
};