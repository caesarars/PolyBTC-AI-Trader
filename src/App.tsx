import { useState } from "react";
import MainLayout from "./components/MainLayout";
import TradingBotPage from "./components/TradingBotPage";
import PaperTradeVisual from "./components/PaperTradeVisual";
import ErrorBoundary from "./components/ErrorBoundary";

export default function App() {
  const [view, setView] = useState<"trading" | "visual">("trading");

  return (
    <MainLayout activeView={view} onChangeView={setView}>
      {view === "trading" && (
        <ErrorBoundary fallbackTitle="Trading Bot crashed"><TradingBotPage /></ErrorBoundary>
      )}
      {view === "visual" && (
        <ErrorBoundary fallbackTitle="Visual page crashed">
          <PaperTradeVisual onBack={() => setView("trading")} />
        </ErrorBoundary>
      )}
    </MainLayout>
  );
}
