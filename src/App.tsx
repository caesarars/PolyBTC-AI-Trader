import BotDashboard from "./components/BotDashboard";
import BotLogSidebar from "./components/BotLogSidebar";

export default function App() {
  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top,rgba(16,185,129,0.12),transparent_22%),linear-gradient(180deg,#09090b_0%,#09090b_45%,#050505_100%)]">
      <main className="mx-auto max-w-6xl px-4 py-6 md:px-8 md:py-8">
        <BotDashboard />
      </main>
      <BotLogSidebar />
    </div>
  );
}
