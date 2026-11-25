import { useEffect, useState } from "react";
import { UserRound } from "lucide-react";
import { cn } from "@/lib/utils";

export function doctorInitials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const initials = parts
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
  return initials || "DR";
}

interface DoctorAvatarProps {
  src?: string | null;
  name: string;
  className?: string;
  iconClassName?: string;
}

export function DoctorAvatar({ src, name, className, iconClassName }: DoctorAvatarProps) {
  const [broken, setBroken] = useState(false);

  useEffect(() => {
    setBroken(false);
  }, [src]);

  const showImage = Boolean(src) && !broken;
  const initials = doctorInitials(name);

  return (
    <div
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-2xl bg-blue-50 text-primary ring-1 ring-blue-100",
        className,
      )}
      aria-hidden="true"
    >
      {showImage ? (
        <img
          src={src ?? undefined}
          alt=""
          className="size-full object-cover"
          onError={() => setBroken(true)}
          loading="lazy"
        />
      ) : initials !== "DR" ? (
        <span className="font-semibold">{initials}</span>
      ) : (
        <UserRound className={cn("size-1/2", iconClassName)} />
      )}
    </div>
  );
}
