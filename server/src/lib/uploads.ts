import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { v2 as cloudinary } from "cloudinary";
import multer from "multer";
import { config } from "../config.js";
import { AppError } from "./appError.js";

export const UPLOADS_ROOT = path.resolve(process.cwd(), "uploads");
export const DOCTOR_PROFILE_UPLOAD_DIR = path.join(UPLOADS_ROOT, "doctors");

export const PROFILE_IMAGE_MAX_BYTES = 2 * 1024 * 1024;
export const PROFILE_IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
};

/**
 * Cloudinary is optional. With a complete credential set, uploads go straight
 * to Cloudinary and the database stores the returned absolute HTTPS URL.
 * Without it, the original local /uploads flow remains intact for development
 * and tests. This keeps Render's ephemeral filesystem out of the picture in
 * production while not forcing every contributor to own a Cloudinary account.
 */
const CLOUDINARY_CLOUD_NAME = config.CLOUDINARY_CLOUD_NAME;
const CLOUDINARY_API_KEY = config.CLOUDINARY_API_KEY;
const CLOUDINARY_API_SECRET = config.CLOUDINARY_API_SECRET;
const CLOUDINARY_READY = Boolean(CLOUDINARY_CLOUD_NAME && CLOUDINARY_API_KEY && CLOUDINARY_API_SECRET);

if (CLOUDINARY_READY && CLOUDINARY_CLOUD_NAME && CLOUDINARY_API_KEY && CLOUDINARY_API_SECRET) {
  cloudinary.config({
    cloud_name: CLOUDINARY_CLOUD_NAME,
    api_key: CLOUDINARY_API_KEY,
    api_secret: CLOUDINARY_API_SECRET,
    secure: true,
  });
}

export function isCloudinaryConfigured(): boolean {
  return CLOUDINARY_READY;
}

function cloudinaryPublicId(doctorId: string): string {
  return `${config.CLOUDINARY_FOLDER}/${doctorId}`;
}

export async function uploadProfileImageToCloudinary(buffer: Buffer, doctorId: string): Promise<string> {
  if (!CLOUDINARY_READY) {
    throw new AppError(503, "IMAGE_STORAGE_UNAVAILABLE", "Cloudinary profile image storage is not configured.");
  }

  const result = await new Promise<{ secure_url?: string }>((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        public_id: cloudinaryPublicId(doctorId),
        resource_type: "image",
        overwrite: true,
        unique_filename: false,
        invalidate: true,
      },
      (error, uploadResult) => {
        if (error || !uploadResult) {
          reject(error ?? new Error("Cloudinary upload failed."));
          return;
        }
        resolve(uploadResult);
      },
    );
    stream.end(buffer);
  });

  if (!result.secure_url) {
    throw new Error("Cloudinary did not return a secure image URL.");
  }
  return result.secure_url;
}

export async function deleteStoredProfileImage(
  url: string | null | undefined,
  doctorId: string,
): Promise<void> {
  if (CLOUDINARY_READY && typeof url === "string" && url.startsWith("https://res.cloudinary.com/")) {
    await cloudinary.uploader.destroy(cloudinaryPublicId(doctorId), {
      resource_type: "image",
      invalidate: true,
    });
    return;
  }
  deleteLocalProfileImage(url);
}

export function ensureUploadDirs(): void {
  fs.mkdirSync(DOCTOR_PROFILE_UPLOAD_DIR, { recursive: true });
}

function doctorDir(doctorId: string): string {
  return path.join(DOCTOR_PROFILE_UPLOAD_DIR, doctorId);
}

export function profileImagePublicUrl(doctorId: string, filename: string): string {
  return `/uploads/doctors/${doctorId}/${filename}`;
}

export function isLocalProfileImageUrl(url: string | null | undefined, doctorId: string): boolean {
  return typeof url === "string" && url.startsWith(`/uploads/doctors/${doctorId}/`);
}

export function deleteLocalProfileImage(url: string | null | undefined): void {
  if (!url || !url.startsWith("/uploads/doctors/")) return;
  const relative = url.replace(/^\/+/, "");
  const absolute = path.resolve(process.cwd(), relative);
  const root = path.resolve(UPLOADS_ROOT);
  if (!absolute.startsWith(root)) return;
  try {
    fs.unlinkSync(absolute);
  } catch {
    // Best-effort cleanup; stale files should not fail the request.
  }
}

const localStorage = multer.diskStorage({
  destination: (req, _file, cb) => {
    const rawId = req.params.id;
    const doctorId = typeof rawId === "string" ? rawId : Array.isArray(rawId) ? rawId[0] : undefined;
    if (!doctorId) {
      cb(new AppError(400, "BAD_REQUEST", "Missing doctor id."), "");
      return;
    }
    const dir = doctorDir(doctorId);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (_req, file, cb) => {
    const ext = EXT_BY_MIME[file.mimetype] ?? ".jpg";
    cb(null, `${Date.now()}-${crypto.randomUUID()}${ext}`);
  },
});

export const uploadDoctorProfileImage = multer({
  storage: CLOUDINARY_READY ? multer.memoryStorage() : localStorage,
  limits: { fileSize: PROFILE_IMAGE_MAX_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!PROFILE_IMAGE_MIME_TYPES.has(file.mimetype)) {
      cb(new AppError(400, "INVALID_IMAGE_TYPE", "Profile image must be a JPG, PNG, or WebP file."));
      return;
    }
    cb(null, true);
  },
}).single("image");
