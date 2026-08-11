import { S3Client } from "@aws-sdk/client-s3";

// Single source of truth for the bucket's region, used both to construct
// the S3 client below and to build public object URLs in putObject.js -
// previously these were two independent reads of process.env.AWS_REGION
// vs a hardcoded literal, which could silently diverge.
export const AWS_REGION = process.env.AWS_REGION || "ap-southeast-2";

const s3 = new S3Client({
    region: AWS_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
});

export default s3;
