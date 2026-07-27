import { Link } from "react-router-dom";

export function NotFound() {
  return (
    <div className="mx-auto max-w-md px-4 py-32 text-center">
      <p className="text-6xl font-bold text-accent">404</p>
      <p className="mt-4 text-zinc-500">This page could not be found.</p>
      <Link
        to="/"
        className="mt-6 inline-block rounded-lg bg-accent px-4 py-2 text-sm font-medium text-zinc-950"
      >
        Go home
      </Link>
    </div>
  );
}
