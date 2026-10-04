import { SidebarShell } from "@/components/layout/sidebar-shell";
import { PublicFooter } from "@/components/layout/public-footer";

export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-paper">
      <SidebarShell>
        <div className="flex min-h-screen flex-col">
          <main className="flex-1">{children}</main>
          <PublicFooter />
        </div>
      </SidebarShell>
    </div>
  );
}
