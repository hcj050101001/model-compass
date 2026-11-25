export type MarginalStepStatus =
  | "normal"
  | "zero_cost_delta"
  | "score_decreased"
  | "cost_decreased"
  | "free_upgrade";

export interface EffortStepInput {
  id: string;
  label: string;
  effortOrder: number;
  score: number | null;
  cost: number | null;
}

export interface EffortMarginalStep {
  fromId: string;
  fromLabel: string;
  toId: string;
  toLabel: string;
  fromScore: number;
  toScore: number;
  fromCost: number;
  toCost: number;
  deltaScore: number;
  relativeScoreChangePct: number | null;
  deltaCost: number;
  relativeCostChangePct: number | null;
  scorePerDollar: number | null;
  costPerScorePoint: number | null;
  status: MarginalStepStatus;
  note: string;
}

export function calculateEffortMarginalReturns(
  variants: EffortStepInput[]
): EffortMarginalStep[] {
  const valid = variants
    .filter(
      (v): v is EffortStepInput & { score: number; cost: number } =>
        typeof v.score === "number" &&
        Number.isFinite(v.score) &&
        typeof v.cost === "number" &&
        Number.isFinite(v.cost)
    )
    .sort((a, b) => a.effortOrder - b.effortOrder);

  const steps: EffortMarginalStep[] = [];
  for (let i = 1; i < valid.length; i++) {
    const prev = valid[i - 1];
    const curr = valid[i];

    const deltaScore = curr.score - prev.score;
    const deltaCost = curr.cost - prev.cost;
    const relativeScoreChangePct =
      prev.score !== 0 ? (deltaScore / prev.score) * 100 : null;
    const relativeCostChangePct =
      prev.cost > 0 ? (deltaCost / prev.cost) * 100 : null;

    let status: MarginalStepStatus = "normal";
    let scorePerDollar: number | null = null;
    let costPerScorePoint: number | null = null;
    let note = "Normal cost-intelligence trade-off";

    if (deltaCost === 0) {
      status = deltaScore > 0 ? "free_upgrade" : "zero_cost_delta";
      note =
        deltaScore > 0
          ? "Score improved with zero additional cost."
          : "No cost change between tiers; marginal $/pt undefined.";
    } else if (deltaCost < 0 && deltaScore >= 0) {
      status = "cost_decreased";
      note = "Higher effort tier was cheaper while maintaining or improving score.";
    } else if (deltaScore <= 0) {
      status = "score_decreased";
      note = "Non-monotonic step: score did not improve at higher effort.";
    } else {
      scorePerDollar = deltaScore / deltaCost;
      costPerScorePoint = deltaCost / deltaScore;
    }

    steps.push({
      fromId: prev.id,
      fromLabel: prev.label,
      toId: curr.id,
      toLabel: curr.label,
      fromScore: prev.score,
      toScore: curr.score,
      fromCost: prev.cost,
      toCost: curr.cost,
      deltaScore,
      relativeScoreChangePct,
      deltaCost,
      relativeCostChangePct,
      scorePerDollar,
      costPerScorePoint,
      status,
      note,
    });
  }

  return steps;
}
