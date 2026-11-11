import { useState } from "react";
import type { ComponentProps } from "react";
import { Eye, EyeOff } from "lucide-react";

/**
 * A password input with the eye toggle that shows/hides what was typed.
 * A drop-in replacement for the plain `<input type="password">` on the auth
 * pages: every prop — including the ref and the handlers react-hook-form's
 * `register` spreads in — lands on the input itself.
 *
 * Two deliberate details:
 * - The toggle is `type="button"`, so clicking it can never submit the
 *   surrounding form the way a bare button would.
 * - The component owns `type` (password/text); callers cannot accidentally
 *   leave the field in plain text.
 */
export function PasswordInput({ className, ...props }: Omit<ComponentProps<"input">, "type">) {
  const [visible, setVisible] = useState(false);

  return (
    <span className="password-field">
      <input {...props} type={visible ? "text" : "password"} className={className} />
      <button
        type="button"
        className="password-toggle"
        onClick={() => setVisible((v) => !v)}
        aria-label={visible ? "Hide password" : "Show password"}
        aria-pressed={visible}
      >
        {visible ? <EyeOff size={16} /> : <Eye size={16} />}
      </button>
    </span>
  );
}
