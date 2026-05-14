import { useState } from "react";
import { Activity, Eye, Menu, X, Bot } from "lucide-react";

type NavItem = {
  id: "trading" | "visual";
  label: string;
  icon: React.ReactNode;
  badge?: string;
  badgeColor?: string;
};

const NAV_ITEMS: NavItem[] = [
  {
    id: "trading",
    label: "Trading Bot",
    icon: <Activity className="w-5 h-5" />,
  },
  {
    id: "visual",
    label: "Paper Visual",
    icon: <Eye className="w-5 h-5" />,
    badge: "LIVE",
    badgeColor: "bg-purple-500/20 text-purple-400",
  },
];

export default function MainLayout({
  activeView,
  onChangeView,
  children,
}: {
  activeView: "trading" | "visual";
  onChangeView: (view: "trading" | "visual") => void;
  children: React.ReactNode;
}) {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <div className="min-h-screen bg-black text-white flex">
      {/* Mobile overlay */}
      {mobileOpen && (
        <div
          className="fixed inset-0 bg-black/60 z-40 md:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={`fixed md:relative z-50 h-screen bg-zinc-950 border-r border-zinc-800 flex flex-col transition-all duration-300 ${
          sidebarOpen ? "w-64" : "w-16"
        } ${mobileOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0"}`}
      >
        {/* Logo */}
        <div className="h-16 flex items-center gap-3 px-4 border-b border-zinc-800">
          <Bot className="w-7 h-7 text-blue-500 shrink-0" />
          {sidebarOpen && (
            <div className="overflow-hidden">
              <div className="text-sm font-bold tracking-tight whitespace-nowrap">PolyBTC Trader</div>
              <div className="text-[9px] text-zinc-600 uppercase tracking-wider whitespace-nowrap">AI-Powered</div>
            </div>
          )}
          <button
            onClick={() => setMobileOpen(false)}
            className="ml-auto md:hidden text-zinc-500 hover:text-white"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Nav Items */}
        <nav className="flex-1 py-4 px-2 space-y-1">
          {NAV_ITEMS.map((item) => {
            const isActive = activeView === item.id;
            return (
              <button
                key={item.id}
                onClick={() => {
                  onChangeView(item.id);
                  setMobileOpen(false);
                }}
                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all group ${
                  isActive
                    ? "bg-blue-500/10 text-blue-400 border border-blue-500/20"
                    : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"
                }`}
                title={!sidebarOpen ? item.label : undefined}
              >
                <span className={isActive ? "text-blue-400" : "text-zinc-500 group-hover:text-zinc-300"}>
                  {item.icon}
                </span>
                {sidebarOpen && (
                  <>
                    <span className="flex-1 text-left">{item.label}</span>
                    {item.badge && (
                      <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold ${item.badgeColor}`}>
                        {item.badge}
                      </span>
                    )}
                  </>
                )}
              </button>
            );
          })}
        </nav>

        {/* Collapse toggle */}
        <div className="p-2 border-t border-zinc-800 hidden md:block">
          <button
            onClick={() => setSidebarOpen(!sidebarOpen)}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-zinc-600 hover:bg-zinc-900 hover:text-zinc-300 transition-all text-xs"
          >
            {sidebarOpen ? (
              <>
                <Menu className="w-4 h-4" />
                <span>Collapse</span>
              </>
            ) : (
              <Menu className="w-4 h-4" />
            )}
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col min-h-screen overflow-hidden">
        {/* Mobile header */}
        <div className="md:hidden h-14 flex items-center gap-3 px-4 border-b border-zinc-800 bg-zinc-950">
          <button onClick={() => setMobileOpen(true)} className="text-zinc-500">
            <Menu className="w-5 h-5" />
          </button>
          <span className="text-sm font-bold">PolyBTC Trader</span>
        </div>

        {/* Content area */}
        <div className="flex-1 overflow-auto">
          {children}
        </div>
      </main>
    </div>
  );
}
