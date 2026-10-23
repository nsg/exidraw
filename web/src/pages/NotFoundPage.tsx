import { Link } from "react-router";
import { StatusPage } from "../components/StatusPage";
import type { DoodleKind } from "../sketch/doodles";
import { BackIcon } from "../folder/icons";

export function NotFoundPage({
  title = "Not found",
  doodle = "lost",
  message = "This page does not exist, or you do not have access to it.",
}: {
  title?: string;
  doodle?: DoodleKind;
  message?: string;
}) {
  return (
    <StatusPage title={title} doodle={doodle}>
      <p className="status-page__text">{message}</p>
      <Link className="sketch-btn" to="/">
        <BackIcon />
        Back to drawings
      </Link>
    </StatusPage>
  );
}
