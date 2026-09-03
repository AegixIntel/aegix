import { redirect } from "next/navigation";

export default function LegacyNotificationsRoute() {
  redirect("/app/notifications");
}
