import { useState } from "react";
import type { FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSession } from "../../hooks/useSession";
import { apiGetDoctor, apiUpdateDoctor, ApiError } from "../../lib/api";

type FieldErrors = Record<string, string>;

/**
 * §5.2's self-edit (Day 14): the descriptive fields plus the credentials the
 * clinic verifies. The server owns the rules — a credential edit forces
 * PENDING_VERIFICATION (hidden from the public list until re-verified), a
 * descriptive-only edit changes nothing, and the fee is absent here because a
 * doctor may not set their own price (the service 403s; the form simply never
 * offers the field). Everything the page shows about status comes from the
 * UPDATE response, never from local imagination.
 */
const INITIAL = {
  fullName: "",
  qualification: "",
  licenseNumber: "",
  experience: "",
  clinicAssociation: "",
  specialization: "",
};

const FIELD_LABELS: Record<"credential" | "descriptive", string> = {
  credential: "Credentials — verified on the public listing",
  descriptive: "Descriptive details",
};

export default function ProfileForm() {
  const { user } = useSession();
  const queryClient = useQueryClient();
  const { data: doctor } = useQuery({
    queryKey: ["doctor", user?.id],
    queryFn: () => apiGetDoctor(user!.id).then((r) => r.doctor),
    enabled: user !== null,
  });

  const [values, setValues] = useState(INITIAL);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);

  // Seed the form once the row arrives, and only into an untouched form.
  if (doctor && loadedFor !== doctor.id) {
    setLoadedFor(doctor.id);
    setValues({
      fullName: doctor.fullName,
      qualification: doctor.qualification ?? "",
      licenseNumber: doctor.licenseNumber ?? "",
      experience: doctor.experience ?? "",
      clinicAssociation: doctor.clinicAssociation ?? "",
      specialization: doctor.specialization ?? "",
    });
  }

  const mutation = useMutation({
    mutationFn: () => apiUpdateDoctor(user!.id, values),
    onSuccess: (result) => {
      setBanner(
        result.verificationStatus === "PENDING_VERIFICATION"
          ? "A credential changed. Your listing is hidden from the public site until the clinic re-verifies you (§5.2)."
          : "Profile updated.",
      );
      setFormError(null);
      setFieldErrors({});
      // The public directory (and the Overview tab) reads this same row; a
      // changed credential can silently unmount a doctor from §26.
      void queryClient.invalidateQueries({ queryKey: ["public", "doctor"] });
      void queryClient.invalidateQueries({ queryKey: ["public", "doctors"] });
      void queryClient.invalidateQueries({ queryKey: ["doctor", user!.id] });
    },
  });

  function update(name: keyof typeof INITIAL, value: string) {
    setValues((prev) => ({ ...prev, [name]: value }));
    setFieldErrors((prev) => {
      if (!(name in prev)) return prev;
      const next = { ...prev };
      delete next[name];
      return next;
    });
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setFormError(null);
    setBanner(null);
    setFieldErrors({});
    try {
      await mutation.mutateAsync();
    } catch (err) {
      if (err instanceof ApiError) {
        setFieldErrors(err.byField());
        if (err.fields.length === 0) setFormError(err.message);
      } else {
        setFormError("Something went wrong. Please try again.");
      }
    }
  }

  return (
    <div>
      <h1>Your profile</h1>
      <p className="hint">
        {doctor ? `Verified as a doctor at this clinic.` : "Loading…"}
      </p>

      {banner && (
        <p className="banner banner-success" role="status">
          {banner}
        </p>
      )}

      <form onSubmit={onSubmit} noValidate>
        <fieldset className="radio-row">
          <legend>{FIELD_LABELS.descriptive}</legend>
          <TextInput label="Full name" name="fullName" value={values.fullName} error={fieldErrors.fullName} onChange={update} />
          <TextInput label="Specialization" name="specialization" value={values.specialization} error={fieldErrors.specialization} onChange={update} />
          <TextInput label="Experience" name="experience" value={values.experience} error={fieldErrors.experience} onChange={update} />
          <TextInput label="Practice / clinic association" name="clinicAssociation" value={values.clinicAssociation} error={fieldErrors.clinicAssociation} onChange={update} />
        </fieldset>

        <fieldset className="radio-row">
          <legend>{FIELD_LABELS.credential}</legend>
          <p className="hint">Editing a credential puts your listing back into re-verification.</p>
          <TextInput label="Qualification" name="qualification" value={values.qualification} error={fieldErrors.qualification} onChange={update} />
          <TextInput label="License number" name="licenseNumber" value={values.licenseNumber} error={fieldErrors.licenseNumber} onChange={update} />
        </fieldset>

        {formError && (
          <p className="form-error" role="alert">
            {formError}
          </p>
        )}

        <button type="submit" disabled={mutation.isPending}>
          {mutation.isPending ? "Saving…" : "Save changes"}
        </button>
      </form>
    </div>
  );
}

function TextInput({
  label,
  name,
  value,
  error,
  onChange,
}: {
  label: string;
  name: string;
  value: string;
  error?: string;
  onChange: (name: keyof typeof INITIAL, value: string) => void;
}) {
  return (
    <>
      <label htmlFor={name}>{label}</label>
      <input
        id={name}
        name={name}
        type="text"
        value={value}
        onChange={(e) => onChange(name as keyof typeof INITIAL, e.target.value)}
      />
      {error && <span className="field-error">{error}</span>}
    </>
  );
}