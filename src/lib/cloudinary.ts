import { v2 as cloudinary, type UploadApiResponse } from 'cloudinary';
import { Readable } from 'node:stream';
import { env } from '../env.js';

cloudinary.config({
  cloud_name: env.CLOUDINARY_CLOUD_NAME,
  api_key: env.CLOUDINARY_API_KEY,
  api_secret: env.CLOUDINARY_API_SECRET,
  secure: true,
});

export interface UploadedImage {
  publicId: string;
  url: string;         // secure https url
  width: number;
  height: number;
  format: string;      // "jpg", "png", …
  bytes: number;
  resourceType: string; // "image" | "video" | "raw"
}

/**
 * Streams a Buffer to Cloudinary under `folder`.
 * Returns the CDN URL + metadata we persist on the asset row.
 */
export function uploadBufferToCloudinary(
  buffer: Buffer,
  opts: { folder: string; publicId: string; resourceType?: 'image' | 'video' | 'auto' },
): Promise<UploadedImage> {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: opts.folder,
        public_id: opts.publicId,
        resource_type: opts.resourceType ?? 'auto',
        overwrite: true,
        unique_filename: false,
        use_filename: false,
      },
      (err, result: UploadApiResponse | undefined) => {
        if (err) return reject(err);
        if (!result) return reject(new Error('Cloudinary returned no result'));
        resolve({
          publicId: result.public_id,
          url: result.secure_url,
          width: result.width,
          height: result.height,
          format: result.format,
          bytes: result.bytes,
          resourceType: result.resource_type,
        });
      },
    );
    Readable.from(buffer).pipe(stream);
  });
}

/**
 * Best-effort deletion — used when a downstream step fails after upload,
 * so we don't leave orphan files in Cloudinary.
 */
export async function safeDeleteCloudinary(publicId: string): Promise<void> {
  try {
    await cloudinary.uploader.destroy(publicId, { invalidate: true });
  } catch (err) {
    console.warn(`[cloudinary] failed to delete ${publicId}:`, err);
  }
}
