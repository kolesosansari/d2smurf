import { cn } from "@/lib/utils";
import { scoreBg, scoreColor } from "@/lib/utils";

interface ScoreBarProps {
  label: string;
  score: number | null | undefined;
  max?: number;
  className?: string;
}

export function ScoreBar({ label, score, max = 12000, className }: ScoreBarProps): React.JSX.Element {
  const value = score ?? 0;
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  const color = scoreColor(score);
  const bg = scoreBg(score);
  return (
    <div className={cn("space-y-1", className)}>
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>{label}</span>
        <span className={cn("font-semibold tabular-nums", color)}>
          {score === null || score === undefined ? "—" : value}
        </span>
      </div>
      <div className={cn("h-2 w-full overflow-hidden rounded-full", bg)}>
        <div
          className={cn(
            "h-full rounded-full transition-all",
            score && score >= 9500
              ? "bg-emerald-400/70"
              : score && score >= 8000
                ? "bg-amber-400/70"
                : score
                  ? "bg-red-400/70"
                  : "bg-muted-foreground/30",
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
