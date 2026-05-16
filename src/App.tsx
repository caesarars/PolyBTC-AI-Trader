import MainLayout from "./components/MainLayout";
import TradingBotPage from "./components/TradingBotPage";
import ErrorBoundary from "./components/ErrorBoundary";

export default function App() {
  return (
    <MainLayout>
      <ErrorBoundary fallbackTitle="Trading Bot crashed">
        <TradingBotPage />
      </ErrorBoundary>
    </MainLayout>
  );
}
