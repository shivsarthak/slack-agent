import { Sidebar } from "@/components/sidebar";
import { StatusBar } from "@/components/status-bar";

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-10 border-b bg-background/80 px-8 py-3.5 backdrop-blur">
          <StatusBar />
        </header>
        <main className="flex-1 overflow-auto px-8 py-8">
          <div className="mx-auto w-full max-w-5xl">{children}</div>
        </main>
      </div>
    </div>
  );
}
