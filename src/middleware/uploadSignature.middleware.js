import fs from "fs";
import multer from "multer";
import path from "path";

const uploadPath =
    "src/uploads/signatures";

if (
    !fs.existsSync(uploadPath)
) {
    fs.mkdirSync(
        uploadPath,
        {
            recursive: true,
        }
    );
}

const storage =
    multer.diskStorage({

        destination: (
            req,
            file,
            cb
        ) => {

            cb(
                null,
                uploadPath
            );

        },

        filename: (
            req,
            file,
            cb
        ) => {

            const uniqueFileName =
                `signature-${Date.now()}-${Math.floor(
                    Math.random() * 100000
                )}${path.extname(
                    file.originalname
                )}`;

            cb(
                null,
                uniqueFileName
            );

        },

    });

export const uploadSignature =
    multer({

        storage,

        limits: {
            fileSize:
                5 * 1024 * 1024,
        },

        fileFilter: (
            req,
            file,
            cb
        ) => {

            const allowedTypes = [
                "image/jpeg",
                "image/jpg",
                "image/png",
                "image/webp",
                "image/heic",
                "image/heif",
            ];

            if (
                !allowedTypes.includes(
                    file.mimetype
                )
            ) {

                return cb(
                    new Error(
                        "Only JPG, JPEG, PNG, WEBP, HEIC or HEIF images are allowed"
                    )
                );

            }

            cb(
                null,
                true
            );

        },

    });