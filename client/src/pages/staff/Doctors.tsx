import AdminDoctorsPage from "@/pages/admin/Doctors"

/**
 * §29's front-desk doctor roster. The same page as the admin dashboard's
 * Doctors tab with the credential decisions hidden: staff may invite, suspend
 * and archive, but verification, rejection, unsuspension and restore remain
 * ADMIN-only.
 */
export default function StaffDoctors() {
  return <AdminDoctorsPage mode="staff" />
}
