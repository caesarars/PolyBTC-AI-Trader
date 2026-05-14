// ── Binary logistic regression — pure TypeScript, no deps ──────────────────────
// Used by the calibrator to turn a heuristic score + indicator features into a
// real probability of WIN. Numerically stable sigmoid; gradient descent with L2.

export interface LogisticModel {
  weights: number[];
  bias: number;
  featureMeans: number[];
  featureStds: number[];
  trainedAt: number;
  nSamples: number;
  // Optimistic (training) metrics
  trainBrier: number;
  trainLogLoss: number;
  // Honest (held-out) metrics. NaN until enough samples for a split.
  cvBrier: number;
  cvLogLoss: number;
  features: string[];
  hyper: { learningRate: number; iterations: number; l2: number };
}

export interface TrainOptions {
  learningRate: number;
  iterations: number;
  l2: number;
  /** Deterministic shuffle seed for k-fold CV. */
  seed: number;
  /** k for k-fold cross-validation. <= 1 disables CV. */
  cvFolds: number;
}

export function sigmoid(x: number): number {
  if (x >= 0) {
    const e = Math.exp(-x);
    return 1 / (1 + e);
  }
  const e = Math.exp(x);
  return e / (1 + e);
}

function dot(a: readonly number[], b: readonly number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

function meanStd(values: number[][], dim: number): { means: number[]; stds: number[] } {
  const n = values.length;
  const means = new Array(dim).fill(0);
  const stds = new Array(dim).fill(0);
  for (let j = 0; j < dim; j++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += values[i][j];
    means[j] = s / Math.max(1, n);
    let s2 = 0;
    for (let i = 0; i < n; i++) s2 += (values[i][j] - means[j]) ** 2;
    stds[j] = Math.sqrt(s2 / Math.max(1, n)) || 1;
  }
  return { means, stds };
}

function standardize(X: number[][], means: number[], stds: number[]): number[][] {
  return X.map((row) => row.map((v, j) => (v - means[j]) / (stds[j] || 1)));
}

// Mulberry32 — deterministic, no deps, sufficient for fold shuffling.
function makeRng(seed: number) {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffleIndices(n: number, seed: number): number[] {
  const idx = Array.from({ length: n }, (_, i) => i);
  const rand = makeRng(seed);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  return idx;
}

interface FitOutput {
  weights: number[];
  bias: number;
}

function fitGD(
  Xn: number[][],
  y: number[],
  opts: { learningRate: number; iterations: number; l2: number }
): FitOutput {
  const n = Xn.length;
  const d = Xn[0]?.length ?? 0;
  const w = new Array(d).fill(0);
  let b = 0;
  for (let iter = 0; iter < opts.iterations; iter++) {
    const grad = new Array(d).fill(0);
    let gradB = 0;
    for (let i = 0; i < n; i++) {
      const z = dot(w, Xn[i]) + b;
      const p = sigmoid(z);
      const err = p - y[i];
      const row = Xn[i];
      for (let j = 0; j < d; j++) grad[j] += err * row[j];
      gradB += err;
    }
    const invN = 1 / Math.max(1, n);
    for (let j = 0; j < d; j++) {
      grad[j] = grad[j] * invN + opts.l2 * w[j];
      w[j] -= opts.learningRate * grad[j];
    }
    b -= opts.learningRate * gradB * invN;
  }
  return { weights: w, bias: b };
}

function scoreSet(
  Xn: number[][],
  y: number[],
  w: number[],
  b: number
): { brier: number; logLoss: number } {
  const n = Xn.length;
  if (n === 0) return { brier: NaN, logLoss: NaN };
  let brierSum = 0;
  let logLossSum = 0;
  for (let i = 0; i < n; i++) {
    const p = sigmoid(dot(w, Xn[i]) + b);
    brierSum += (p - y[i]) ** 2;
    const pClip = Math.min(0.9999, Math.max(0.0001, p));
    logLossSum += -(y[i] * Math.log(pClip) + (1 - y[i]) * Math.log(1 - pClip));
  }
  return { brier: brierSum / n, logLoss: logLossSum / n };
}

export function trainLogistic(
  X: number[][],
  y: number[],
  features: string[],
  opts: Partial<TrainOptions> = {}
): LogisticModel {
  const hyper = {
    learningRate: opts.learningRate ?? 0.1,
    iterations: opts.iterations ?? 2000,
    l2: opts.l2 ?? 0.01,
  };
  const seed = opts.seed ?? 42;
  const cvFolds = Math.max(1, opts.cvFolds ?? 5);

  const n = X.length;
  if (n === 0) throw new Error("trainLogistic: empty dataset");
  const d = X[0].length;
  if (features.length !== d) {
    throw new Error(`trainLogistic: features.length=${features.length} != X[0].length=${d}`);
  }

  // ── Final model: standardize on full data, train on full data ──────────────
  const { means, stds } = meanStd(X, d);
  const Xn = standardize(X, means, stds);
  const { weights, bias } = fitGD(Xn, y, hyper);
  const trainMetrics = scoreSet(Xn, y, weights, bias);

  // ── Honest k-fold CV (no leakage: each fold restandardized on its own train) ──
  let cvBrier = NaN;
  let cvLogLoss = NaN;
  if (cvFolds > 1 && n >= cvFolds * 4) {
    const idx = shuffleIndices(n, seed);
    let brierSum = 0;
    let logLossSum = 0;
    let totalEval = 0;
    for (let k = 0; k < cvFolds; k++) {
      const testIdx: number[] = [];
      const trainIdx: number[] = [];
      for (let i = 0; i < n; i++) {
        if (i % cvFolds === k) testIdx.push(idx[i]);
        else trainIdx.push(idx[i]);
      }
      if (trainIdx.length === 0 || testIdx.length === 0) continue;
      const Xtr = trainIdx.map((i) => X[i]);
      const ytr = trainIdx.map((i) => y[i]);
      const Xte = testIdx.map((i) => X[i]);
      const yte = testIdx.map((i) => y[i]);
      const { means: m, stds: s } = meanStd(Xtr, d);
      const Xtrn = standardize(Xtr, m, s);
      const Xten = standardize(Xte, m, s);
      const fit = fitGD(Xtrn, ytr, hyper);
      const foldScore = scoreSet(Xten, yte, fit.weights, fit.bias);
      if (!Number.isNaN(foldScore.brier)) {
        brierSum += foldScore.brier * Xten.length;
        logLossSum += foldScore.logLoss * Xten.length;
        totalEval += Xten.length;
      }
    }
    if (totalEval > 0) {
      cvBrier = brierSum / totalEval;
      cvLogLoss = logLossSum / totalEval;
    }
  }

  return {
    weights,
    bias,
    featureMeans: means,
    featureStds: stds,
    trainedAt: Date.now(),
    nSamples: n,
    trainBrier: trainMetrics.brier,
    trainLogLoss: trainMetrics.logLoss,
    cvBrier,
    cvLogLoss,
    features,
    hyper,
  };
}

export function predictLogistic(model: LogisticModel, features: number[]): number {
  if (features.length !== model.weights.length) {
    throw new Error(
      `predictLogistic: feature dim mismatch (got ${features.length}, expected ${model.weights.length})`
    );
  }
  const xn = features.map((v, j) => (v - model.featureMeans[j]) / (model.featureStds[j] || 1));
  return sigmoid(dot(model.weights, xn) + model.bias);
}
