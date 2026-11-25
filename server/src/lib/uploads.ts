import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import multer from "multer";
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

const storage = multer.diskStorage({
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
  storage,
  limits: { fileSize: PROFILE_IMAGE_MAX_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!PROFILE_IMAGE_MIME_TYPES.has(file.mimetype)) {
      cb(new AppError(400, "INVALID_IMAGE_TYPE", "Profile image must be a JPG, PNG, or WebP file."));
      return;
    }
    cb(null, true);
  },
}).single("image");
