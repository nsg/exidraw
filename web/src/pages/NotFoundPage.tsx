import { Link } from "react-router";

export function NotFoundPage({ message = "This page does not exist, or you do not have access to it." }: { message?: string }) {
  return (
    <div className="empty">
      <h2>Not found</h2>
      <p>{message}</p>
      <Link className="btn" to="/">
        Back to drawings
      </Link>
    </div>
  );
}
