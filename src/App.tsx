import { useState } from "react";
import MainLayout from "./components/MainLayout";
import TradingBotPage from "./components/TradingBotPage";
import PaperTradeVisual from "./components/PaperTradeVisual";
import SwarmDashboard from "./components/SwarmDashboard";

export default function App() {
  const [view, setView] = useState<"trading" | "swarm" | "visual">("trading");

  return (
    <MainLayout activeView={view} onChangeView={setView}>
      {view === "trading" && <TradingBotPage />}
      {view === "swarm" && <SwarmDashboard onBack={() => setView("trading")} />}
      {view === "visual" && <PaperTradeVisual onBack={() => setView("trading")} />}
    </MainLayout>
  );
}
