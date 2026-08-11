import { PutObjectCommand } from "@aws-sdk/client-s3";
import s3, { AWS_REGION } from "../../../config/s3.js";

export const putObject = async (
    file,
    filename,
    contentType
) => {

    const command = new PutObjectCommand({
        Bucket: process.env.AWS_S3_BUCKET_NAME,
        Key: filename,
        Body: file,
        ContentType: contentType,
    });

    const data = await s3.send(command);

    return {
        key: filename,
        url:
            `https://${process.env.AWS_S3_BUCKET_NAME}` +
            `.s3.${AWS_REGION}.amazonaws.com/${filename}`
    };
};





