// One-time helper for the two showcase doctor profile images.
//
//   npm run images:upload-doctor-profiles -- <asha-image> <rohit-image>
//
// The shared env loader reads the repository root .env.local first, so this
// script writes to the deployed Neon branch rather than the local Postgres in
// server/.env. Cloudinary credentials must be present in that same env.

import fs from "node:fs";
import path from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { config } from "../src/config.js";
import { isCloudinaryConfigured, PROFILE_IMAGE_MAX_BYTES, uploadProfileImageToCloudinary } from "../src/lib/uploads.js";

const [ashaPath, rohitPath] = process.argv.slice(2);

if (!ashaPath || !rohitPath) {
  console.error("Usage: npm run images:upload-doctor-profiles -- <asha-image> <rohit-image>");
  process.exit(1);
}

if (!isCloudinaryConfigured()) {
  console.error("Cloudinary is not configured. Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET.");
  process.exit(1);
}

const targets = [
  { label: "Dr Asha Menon", email: "doctor.asha@example.test", file: ashaPath },
  { label: "Dr Rohit Sharma", email: "doctor.rohit@example.test", file: rohitPath },
];

const prisma = new PrismaClient({
  adapter: new PrismaPg({
    connectionString: process.env.DATABASE_URL_UNPOOLED ?? config.DATABASE_URL,
    connectionTimeoutMillis: 10_000,
  }),
});

try {
  for (const target of targets) {
    const absolute = path.resolve(target.file);
    if (!fs.existsSync(absolute)) {
      throw new Error(`${target.label}: file not found at ${absolute}`);
    }
    const stat = fs.statSync(absolute);
    if (stat.size > PROFILE_IMAGE_MAX_BYTES) {
      throw new Error(`${target.label}: image is larger than ${PROFILE_IMAGE_MAX_BYTES} bytes`);
    }

    const user = await prisma.user.findUnique({
      where: { email: target.email },
      select: { id: true },
    });
    if (!user) {
      throw new Error(`${target.label}: no user found for ${target.email}`);
    }

    const url = await uploadProfileImageToCloudinary(fs.readFileSync(absolute), user.id);
    await prisma.doctorProfile.update({
      where: { userId: user.id },
      data: { profileImageUrl: url },
    });

    console.log(`${target.label}: ${url}`);
  }
} finally {
  await prisma.$disconnect();
}
