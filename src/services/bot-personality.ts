export interface BotProfile {
  id: number;
  name: string;
  strategy: string;
  description: string;
  confidenceStyle: "conservative" | "moderate" | "aggressive";
  temperature: number;
  accuracy: number;
  totalPredictions: number;
  correctPredictions: number;
  currentWeight: number;
  streak: number;
  parameters: {
    fastLoopWeight: number;
    divergenceWeight: number;
    heatWeight: number;
    technicalWeight: number;
    riskTolerance: number;
  };
}

const STRATEGY_TEMPLATES = [
  "You are a momentum trader who believes trends persist. You weight recent price action heavily and enter in the direction of the dominant move.",
  "You are a contrarian trader who fades extreme moves. You look for overbought/oversold conditions and bet against the crowd.",
  "You are a technical analyst who relies on indicators. You trust RSI, MACD, and EMA crossovers above all else.",
  "You are a market microstructure specialist. You analyze order flow, funding rates, and liquidation cascades.",
  "You are a sentiment trader. You read market heat, crowd positioning, and contrarian signals.",
  "You are a breakout trader. You wait for key levels to break and then ride the volatility expansion.",
  "You are a mean reversion specialist. You believe prices return to their average after large deviations.",
  "You are a scalper who takes quick profits. You enter on small edge and exit fast.",
  "You are a macro trader who considers broader market conditions. You connect BTC moves to traditional markets.",
  "You are a pattern recognition expert. You identify candlestick patterns and chart formations.",
];

const RISK_PROFILES = [
  { style: "conservative" as const, temp: 0.3, risk: 0.2 },
  { style: "moderate" as const, temp: 0.6, risk: 0.5 },
  { style: "aggressive" as const, temp: 0.9, risk: 0.8 },
];

const BOT_NAMES = [
  "MomentumMaster", "ContrarianKing", "TechWhiz", "FlowHunter", "SentimentSage",
  "BreakoutBeast", "MeanReversion", "Scalpel", "MacroMaven", "PatternPro",
  "TrendRider", "FadeFighter", "RSIRider", "MACDMaster", "BollingerBandit",
  "FundingFalcon", "Liquidator", "HeatSeeker", "VolatilityViper", "ChartChampion",
  "CandleCrusher", "SupportSnatcher", "ResistanceRider", "EMAElite", "VolumeVulture",
  "DivergenceDetective", "FibonacciFanatic", "IchimokuExpert", "WyckoffWolf", "ElliottEagle",
  "GapGunner", "RangeRanger", "SwingSlayer", "DayDominator", "PositionPro",
  "ArbitrageAce", "HedgeHog", "DeltaDiver", "GammaGuru", "ThetaThief",
  "VegaVeteran", "RhoRanger", "IVCrusher", "SkewSlayer", "TermTactician",
  "CrossCrusher", "CarryKing", "SwapSwiper", "FutureFalcon", "PerpPredator",
  "SpotSniper", "MarginMaster", "LeverageLord", "CollateralCrusher", "LiquidationLurker",
  "FundingFarmer", "PremiumPicker", "BasisBandit", "SpreadSlayer", "PairProfiteer",
  "StatArbStar", "IndexInnovator", "ETFElite", "TrustTrader", "NoteNavigator",
  "BondBandit", "YieldYak", "RateRider", "CurveCrusher", "SwaptionSniper",
  "CapCapturer", "FloorFighter", "CollarCrusher", "WarrantWizard", "ConvertibleCrusher",
  "OptionOracle", "BinaryBoss", "TouchTactician", "NoTouchNinja", "RangeRuler",
  "BarrierBreaker", "KnockoutKing", "AccumulatorAce", "DecumulatorDemon", "AutocallAce",
  "SnowballSniper", "PhoenixPredator", "TARNTrader", "VarianceVampire", "VolSwapSwiper",
  "CorrelationCrusher", "DispersionDemon", "BasketBandit", "WorstOfWizard", "BestOfBeast",
  "RainbowRider", "MountainMaster", "CliffCrusher", "DigitalDominator", "AsianAce",
  "LookbackLord", "CompoundCrusher", "ChooserChampion", "ShoutShooter", "PowerPro",
  "ForwardFalcon", "FutureFlow", "SwapStream", "CreditCrusher", "CDSChampion",
  "TrancheTactician", "SecuritizationSage", "ABSAce", "MBSMaster", "CMOCrusher",
];

function seededRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 16807 + 0) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

export function generateBotProfiles(count: number = 100): BotProfile[] {
  const rng = seededRandom(42); // deterministic seed
  const profiles: BotProfile[] = [];

  for (let i = 0; i < count; i++) {
    const name = BOT_NAMES[i % BOT_NAMES.length] + (i >= BOT_NAMES.length ? `_${Math.floor(i / BOT_NAMES.length)}` : "");
    const strategyIdx = Math.floor(rng() * STRATEGY_TEMPLATES.length);
    const strategy = STRATEGY_TEMPLATES[strategyIdx];
    const riskIdx = Math.floor(rng() * RISK_PROFILES.length);
    const risk = RISK_PROFILES[riskIdx];

    // Generate unique parameter variations
    const fastLoopWeight = 0.5 + rng() * 1.5;      // 0.5 - 2.0
    const divergenceWeight = rng() * 2.0;           // 0.0 - 2.0
    const heatWeight = rng() * 2.0;                 // 0.0 - 2.0
    const technicalWeight = 0.5 + rng() * 1.5;      // 0.5 - 2.0
    const riskTolerance = risk.risk + (rng() - 0.5) * 0.2; // Slight variation

    // Add unique flavor to each bot's strategy description
    const flavors = [
      "You prefer high-confidence setups and avoid noise.",
      "You trade frequently and accept lower win rates for higher volume.",
      "You wait for confluence of multiple signals before entering.",
      "You act on the first sign of momentum and cut losses quickly.",
      "You scale into positions as confirmation builds.",
    ];
    const flavor = flavors[Math.floor(rng() * flavors.length)];

    profiles.push({
      id: i + 1,
      name,
      strategy,
      description: `${strategy} ${flavor}`,
      confidenceStyle: risk.style,
      temperature: risk.temp + (rng() - 0.5) * 0.1,
      accuracy: 0.5, // Start at coin flip
      totalPredictions: 0,
      correctPredictions: 0,
      currentWeight: 1.0,
      streak: 0,
      parameters: {
        fastLoopWeight: parseFloat(fastLoopWeight.toFixed(2)),
        divergenceWeight: parseFloat(divergenceWeight.toFixed(2)),
        heatWeight: parseFloat(heatWeight.toFixed(2)),
        technicalWeight: parseFloat(technicalWeight.toFixed(2)),
        riskTolerance: parseFloat(Math.max(0, Math.min(1, riskTolerance)).toFixed(2)),
      },
    });
  }

  return profiles;
}

// Singleton instance for runtime
let _botProfiles: BotProfile[] | null = null;

export function getBotProfiles(): BotProfile[] {
  if (!_botProfiles) {
    _botProfiles = generateBotProfiles(100);
  }
  return _botProfiles;
}

export function resetBotProfiles(): BotProfile[] {
  _botProfiles = generateBotProfiles(100);
  return _botProfiles;
}

export function updateBotAccuracy(botId: number, correct: boolean): void {
  const profiles = getBotProfiles();
  const bot = profiles.find((b) => b.id === botId);
  if (!bot) return;

  bot.totalPredictions++;
  if (correct) {
    bot.correctPredictions++;
    bot.streak = bot.streak > 0 ? bot.streak + 1 : 1;
  } else {
    bot.streak = bot.streak < 0 ? bot.streak - 1 : -1;
  }

  // Elo-style rating update
  const k = 32;
  const expected = bot.accuracy;
  const actual = correct ? 1 : 0;
  bot.accuracy = bot.accuracy + (k / 100) * (actual - expected);
  bot.accuracy = Math.max(0.1, Math.min(0.99, bot.accuracy));

  // Update weight based on accuracy
  bot.currentWeight = bot.accuracy;
}
