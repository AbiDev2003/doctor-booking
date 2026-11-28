import { Route, Routes } from "react-router-dom";
import Register from "./pages/Register.tsx";
import VerifyEmail from "./pages/VerifyEmail.tsx";
import VerifyEmailChange from "./pages/VerifyEmailChange.tsx";
import Login from "./pages/Login.tsx";
import ForgotPassword from "./pages/ForgotPassword.tsx";
import ResetPassword from "./pages/ResetPassword.tsx";
import ClaimAccount from "./pages/ClaimAccount.tsx";
import Profile from "./pages/Profile.tsx";
import NotFound from "./pages/NotFound.tsx";
import PublicLayout from "./layouts/PublicLayout.tsx";
import Home from "./pages/Home.tsx";
import Doctors from "./pages/Doctors.tsx";
import DoctorProfile from "./pages/DoctorProfile.tsx";
import DoctorLayout from "./layouts/DoctorLayout.tsx";
import Overview from "./pages/doctor/Overview.tsx";
import Queue from "./pages/doctor/Queue.tsx";
import ProfileForm from "./pages/doctor/ProfileForm.tsx";
import Schedule from "./pages/doctor/Schedule.tsx";
import PatientLayout from "./layouts/PatientLayout.tsx";
import PatientOverview from "./pages/patient/Overview.tsx";
import Appointments from "./pages/patient/Appointments.tsx";
import Reschedule from "./pages/patient/Reschedule.tsx";
import Payments from "./pages/patient/Payments.tsx";
import StaffLayout from "./layouts/StaffLayout.tsx";
import StaffToday from "./pages/staff/Today.tsx";
import StaffHistory from "./pages/staff/History.tsx";
import StaffAppointments from "./pages/staff/Appointments.tsx";
import StaffPatients from "./pages/staff/Patients.tsx";
import StaffPayments from "./pages/staff/Payments.tsx";
import StaffSchedule from "./pages/staff/Schedule.tsx";
import StaffDoctors from "./pages/staff/Doctors.tsx";
import AdminLayout from "./layouts/AdminLayout.tsx";
import AdminOverview from "./pages/admin/Overview.tsx";
import AdminDoctors from "./pages/admin/Doctors.tsx";
import AdminStaff from "./pages/admin/Staff.tsx";
import AdminPatients from "./pages/admin/Patients.tsx";
import AdminAppointments from "./pages/admin/Appointments.tsx";
import AdminSchedule from "./pages/admin/Schedule.tsx";
import AdminScheduleRequests from "./pages/admin/ScheduleRequests.tsx";
import AdminPayments from "./pages/admin/Payments.tsx";
import AdminNotifications from "./pages/admin/Notifications.tsx";
import AdminAudit from "./pages/admin/Audit.tsx";
import AdminSettings from "./pages/admin/Settings.tsx";

/**
 * Day 13/14 routing. The root path now earns the public storefront (the
 * comment that used to justify Login as the front door is obsolete), and the
 * `/doctor/*` shell is grouped under one layout whose role guard owns the
 * "should this tourist be here" decision. Every 401-sensitive page still does
 * its own session boot; the layouts add the shared chrome and guard.
 */
export default function App() {
  return (
    <Routes>
      {/* §26 public storefront + auth flows (shared public chrome). */}
      <Route element={<PublicLayout />}>
        <Route path="/" element={<Home />} />
        <Route path="/doctors" element={<Doctors />} />
        <Route path="/doctors/:id" element={<DoctorProfile />} />
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Register />} />
        <Route path="/forgot-password" element={<ForgotPassword />} />
        <Route path="/reset-password" element={<ResetPassword />} />
        <Route path="/verify-email" element={<VerifyEmail />} />
        <Route path="/verify-email-change" element={<VerifyEmailChange />} />
        <Route path="/claim-account" element={<ClaimAccount />} />
        <Route path="*" element={<NotFound />} />
      </Route>

      {/* §28 doctor dashboard (Day 14). */}
      <Route path="/doctor" element={<DoctorLayout />}>
        <Route index element={<Overview />} />
        <Route path="queue" element={<Queue />} />
        <Route path="profile" element={<ProfileForm />} />
        <Route path="schedule" element={<Schedule />} />
        <Route path="*" element={<NotFound />} />
      </Route>

      {/* §27 patient dashboard (Day 30). */}
      <Route path="/patient" element={<PatientLayout />}>
        <Route index element={<PatientOverview />} />
        <Route path="appointments" element={<Appointments />} />
        <Route path="appointments/:id/reschedule" element={<Reschedule />} />
        <Route path="payments" element={<Payments />} />
        <Route path="*" element={<NotFound />} />
      </Route>

      {/* §16/§29 staff front desk (Day 32). */}
      <Route path="/staff" element={<StaffLayout />}>
        <Route index element={<StaffToday />} />
        <Route path="history" element={<StaffHistory />} />
        <Route path="appointments" element={<StaffAppointments />} />
        <Route path="patients" element={<StaffPatients />} />
        <Route path="payments" element={<StaffPayments />} />
        <Route path="schedule" element={<StaffSchedule />} />
        <Route path="doctors" element={<StaffDoctors />} />
        <Route path="*" element={<NotFound />} />
      </Route>

      {/* §29 admin dashboard (Day 33). STAFF are redirected to the desk. */}
      <Route path="/admin" element={<AdminLayout />}>
        <Route index element={<AdminOverview />} />
        <Route path="doctors" element={<AdminDoctors />} />
        <Route path="staff" element={<AdminStaff />} />
        <Route path="patients" element={<AdminPatients />} />
        <Route path="appointments" element={<AdminAppointments />} />
        <Route path="schedule" element={<AdminSchedule />} />
        <Route path="schedule-requests" element={<AdminScheduleRequests />} />
        <Route path="payments" element={<AdminPayments />} />
        <Route path="notifications" element={<AdminNotifications />} />
        <Route path="audit" element={<AdminAudit />} />
        <Route path="settings" element={<AdminSettings />} />
        <Route path="*" element={<NotFound />} />
      </Route>

      {/* Account flow (shared across roles), standalone. */}
      <Route path="/profile" element={<Profile />} />
    </Routes>
  );
}