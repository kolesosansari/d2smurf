import { cn } from "@/lib/utils";
import { rankTierToInfo } from "@shared/types";

const MEDAL_COLORS: Record<number, { ring: string; bg: string; text: string }> = {
  1: { ring: "ring-rank-herald/40", bg: "bg-rank-herald/20", text: "text-stone-300" },
  2: { ring: "ring-rank-guardian/40", bg: "bg-rank-guardian/20", text: "text-emerald-300" },
  3: { ring: "ring-rank-crusader/40", bg: "bg-rank-crusader/20", text: "text-stone-200" },
  4: { ring: "ring-rank-archon/40", bg: "bg-rank-archon/20", text: "text-amber-300" },
  5: { ring: "ring-rank-legend/40", bg: "bg-rank-legend/20", text: "text-sky-300" },
  6: { ring: "ring-rank-ancient/40", bg: "bg-rank-ancient/20", text: "text-purple-300" },
  7: { ring: "ring-rank-divine/40", bg: "bg-rank-divine/20", text: "text-pink-300" },
  8: { ring: "ring-rank-immortal/40", bg: "bg-rank-immortal/20", text: "text-yellow-300" },
};

interface RankBadgeProps {
  rankTier: number | null;
  mmr: number | null;
  leaderboardRank?: number | null;
  size?: "sm" | "md" | "lg";
  className?: string;
}

export function RankBadge({
  rankTier,
  mmr,
  leaderboardRank,
  size = "md",
  className,
}: RankBadgeProps): React.JSX.Element {
  const info = rankTierToInfo(rankTier);
  const colors = info ? MEDAL_COLORS[info.medal] : null;
  const sizeClasses =
    size === "sm" ? "h-10 w-10 text-[10px]" : size === "lg" ? "h-16 w-16 text-sm" : "h-12 w-12 text-xs";

  if (!info) {
    return (
      <div
        className={cn(
          "flex items-center justify-center rounded-full bg-muted text-muted-foreground ring-2 ring-muted-foreground/20",
          sizeClasses,
          className,
        )}
        title="Без ранга"
      >
        ?
      </div>
    );
  }

  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center rounded-full font-bold ring-2 leading-tight",
        colors?.bg,
        colors?.ring,
        colors?.text,
        sizeClasses,
        className,
      )}
      title={`${info.name} ${info.medal === 8 ? "" : info.stars} • MMR ${mmr ?? "?"}`}
    >
      <span className="uppercase tracking-wider">{info.name.slice(0, 4)}</span>
      <span className="mt-0.5 text-xs">
        {info.medal === 8
          ? leaderboardRank
            ? `#${leaderboardRank}`
            : ""
          : "★".repeat(info.stars)}
      </span>
    </div>
  );
}
