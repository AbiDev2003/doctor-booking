import { Route, Routes } from "react-router-dom";
import Register from "./pages/Register.tsx";
import VerifyEmail from "./pages/VerifyEmail.tsx";
import VerifyEmailChange from "./pages/VerifyEmailChange.tsx";
import Login from "./pages/Login.tsx";
import ForgotPassword from "./pages/ForgotPassword.tsx";
import ResetPassword from "./pages/ResetPassword.tsx";
import ClaimAccount from "./pages/ClaimAccount.tsx";
import Profile from "./pages/Profile.tsx";
import PublicLayout from "./layouts/PublicLayout.tsx";
import Home from "./pages/Home.tsx";
import Doctors from "./pages/Doctors.tsx";
import DoctorProfile from "./pages/DoctorProfile.tsx";
import DoctorLayout from "./layouts/DoctorLayout.tsx";
import Overview from "./pages/doctor/Overview.tsx";
import Queue from "./pages/doctor/Queue.tsx";
import ProfileForm from "./pages/doctor/ProfileForm.tsx";
import Schedule from "./pages/doctor/Schedule.tsx";

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
      {/* §26 public storefront (Day 13). */}
      <Route element={<PublicLayout />}>
        <Route path="/" element={<Home />} />
        <Route path="/doctors" element={<Doctors />} />
        <Route path="/doctors/:id" element={<DoctorProfile />} />
      </Route>

      {/* §28 doctor dashboard (Day 14). */}
      <Route path="/doctor" element={<DoctorLayout />}>
        <Route index element={<Overview />} />
        <Route path="queue" element={<Queue />} />
        <Route path="profile" element={<ProfileForm />} />
        <Route path="schedule" element={<Schedule />} />
      </Route>

      {/* Auth + account flows (Days 7–12), standalone. */}
      <Route path="/register" element={<Register />} />
      <Route path="/verify-email" element={<VerifyEmail />} />
      <Route path="/login" element={<Login />} />
      <Route path="/forgot-password" element={<ForgotPassword />} />
      <Route path="/reset-password" element={<ResetPassword />} />
      <Route path="/verify-email-change" element={<VerifyEmailChange />} />
      <Route path="/claim-account" element={<ClaimAccount />} />
      <Route path="/profile" element={<Profile />} />

      {/* Unknown paths land on the storefront, top of the funnel. */}
      <Route path="*" element={<Home />} />
    </Routes>
  );
}