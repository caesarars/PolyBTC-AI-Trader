// Minimalist top-bar layout. No sidebar — navigation lives in a single thin
// header strip. Designed to disappear: small type, low contrast, no icons.

type ViewId = "trading" | "visual";

const TABS: { id: ViewId; label: string }[] = [
  { id: "trading", label: "Trading" },
  { id: "visual",  label: "Paper Visual" },
];

export default function MainLayout({
  activeView,
  onChangeView,
  children,
}: {
  activeView: ViewId;
  onChangeView: (view: ViewId) => void;
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-black text-white flex flex-col">
      <header className="h-12 flex items-center px-4 md:px-8 border-b border-zinc-900 sticky top-0 z-30 bg-black/80 backdrop-blur">
        <div className="text-[11px] tracking-[0.2em] uppercase text-zinc-500 font-medium mr-8">
          PolyBTC
        </div>
        <nav className="flex items-center gap-1">
          {TABS.map((tab) => {
            const isActive = activeView === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => onChangeView(tab.id)}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                  isActive
                    ? "text-white bg-zinc-900"
                    : "text-zinc-500 hover:text-zinc-200"
                }`}
              >
                {tab.label}
              </button>
            );
          })}
        </nav>
      </header>

      <main className="flex-1 overflow-auto">
        {children}
      </main>
    </div>
  );
}
