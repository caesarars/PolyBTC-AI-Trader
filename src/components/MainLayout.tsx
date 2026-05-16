// Minimalist top-bar layout. No sidebar — navigation lives in a single thin
// header strip. Designed to disappear: small type, low contrast, no icons.

export default function MainLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-black text-white flex flex-col">
      <header className="h-12 flex items-center px-4 md:px-8 border-b border-zinc-900 sticky top-0 z-30 bg-black/80 backdrop-blur">
        <div className="text-[11px] tracking-[0.2em] uppercase text-zinc-500 font-medium">
          PolyBTC
        </div>
      </header>

      <main className="flex-1 overflow-auto">
        {children}
      </main>
    </div>
  );
}
