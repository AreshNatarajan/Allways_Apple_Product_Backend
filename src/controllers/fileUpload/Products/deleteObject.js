import { DeleteObjectCommand } from "@aws-sdk/client-s3";
import s3 from "../../../config/s3.js";

export const deleteObject = async (key) => {
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