import { Route, Routes } from "react-router-dom";
import Register from "./pages/Register.tsx";
import VerifyEmail from "./pages/VerifyEmail.tsx";
import VerifyEmailChange from "./pages/VerifyEmailChange.tsx";
import Login from "./pages/Login.tsx";
import ForgotPassword from "./pages/ForgotPassword.tsx";
import ResetPassword from "./pages/ResetPassword.tsx";
import Profile from "./pages/Profile.tsx";

export default function App() {
  return (
    <Routes>
      <Route path="/register" element={<Register />} />
      <Route path="/verify-email" element={<VerifyEmail />} />
      {/* Day 11 recovery + account routes (§6.1/§6.2). */}
      <Route path="/login" element={<Login />} />
      <Route path="/forgot-password" element={<ForgotPassword />} />
      <Route path="/reset-password" element={<ResetPassword />} />
      <Route path="/verify-email-change" element={<VerifyEmailChange />} />
      <Route path="/profile" element={<Profile />} />
      {/* Login is the front door until a patient dashboard (Day 13) earns
          the root path. */}
      <Route path="*" element={<Login />} />
    </Routes>
  );
}
