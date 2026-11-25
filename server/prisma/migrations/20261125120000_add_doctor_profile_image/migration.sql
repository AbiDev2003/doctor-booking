-- Add doctor profile image URL (descriptive field, not credential-impacting).
ALTER TABLE "doctor_profiles" ADD COLUMN "profile_image_url" TEXT;
