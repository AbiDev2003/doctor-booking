import { Link, useLocation } from "react-router-dom";
import { ArrowLeft, Home } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  const location = useLocation();

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col items-center justify-center px-4 py-16 text-center sm:px-6 sm:py-24">
      <p className="text-sm font-semibold uppercase tracking-[0.2em] text-primary">Error 404</p>
      <h1 className="mt-4 text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl">Page not found</h1>
      <p className="mt-4 max-w-xl text-base leading-7 text-slate-600">
        The page you’re looking for doesn’t exist or may have been moved. Check the URL, or head back to a safe place.
      </p>
      <p className="mt-3 rounded-full border border-slate-200 bg-white px-4 py-1.5 text-xs text-slate-500">
        Requested path: <span className="font-medium text-slate-700">{location.pathname}</span>
      </p>
      <div className="mt-8 flex flex-col gap-3 sm:flex-row">
        <Button asChild>
          <Link to="/">
            <Home className="size-4" aria-hidden="true" />
            Go to home
          </Link>
        </Button>
        <Button asChild variant="outline" className="bg-white">
          <Link to="/doctors">
            <ArrowLeft className="size-4" aria-hidden="true" />
            Browse doctors
          </Link>
        </Button>
      </div>
    </div>
  );
}
