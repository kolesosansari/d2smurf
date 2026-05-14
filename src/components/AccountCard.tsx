import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  AlertOctagon,
  Copy,
  Eye,
  EyeOff,
  GripVertical,
  KeyRound,
  Play,
  RefreshCcw,
  ShieldCheck,
  Trash2,
  Mail,
  StickyNote,
} from "lucide-react";
import { useState } from "react";
import type { AccountRow } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { RankBadge } from "@/components/RankBadge";
import { ScoreBar } from "@/components/ScoreBar";
import { cn, formatRelativeTime } from "@/lib/utils";

interface AccountCardProps {
  account: AccountRow;
  draggable?: boolean;
  onCheck?: (id: string) => void;
  onDeepCheck?: (id: string) => void;
  onLaunch?: (id: string) => void;
  onLaunchOverplus?: (id: string) => void;
  onShowDetails?: (id: string) => void;
  onDelete?: (id: string) => void;
  onShowMaCode?: (id: string) => void;
}

export function AccountCard({
  account,
  draggable = true,
  onCheck,
  onDeepCheck,
  onLaunch,
  onLaunchOverplus,
  onShowDetails,
  onDelete,
  onShowMaCode,
}: AccountCardProps): React.JSX.Element {
  const sortable = useSortable({ id: account.id, disabled: !draggable });
  const [showPassword, setShowPassword] = useState(false);

  const style = {
    transform: CSS.Transform.toString(sortable.transform),
    transition: sortable.transition,
  };

  return (
    <Card
      ref={sortable.setNodeRef}
      style={style}
      className={cn(
        "group relative overflow-hidden border-border/60 transition-shadow hover:shadow-lg",
        sortable.isDragging && "ring-2 ring-primary",
      )}
    >
      <CardContent className="flex flex-col gap-3 p-4">
        <div className="flex items-start gap-3">
          {draggable && (
            <button
              type="button"
              className="mt-1 cursor-grab opacity-30 transition-opacity hover:opacity-100 active:cursor-grabbing"
              aria-label="drag handle"
              {...sortable.attributes}
              {...sortable.listeners}
            >
              <GripVertical className="h-4 w-4" />
            </button>
          )}

          <div className="relative shrink-0">
            {account.avatarUrl ? (
              <img
                src={account.avatarUrl}
                alt={account.personaName ?? account.login}
                className="h-14 w-14 rounded-lg border border-border object-cover"
                referrerPolicy="no-referrer"
              />
            ) : (
              <div className="grid h-14 w-14 place-items-center rounded-lg border border-border bg-muted text-xs text-muted-foreground">
                Нет
              </div>
            )}
            {account.hasMaFile === 1 && (
              <Badge
                variant="success"
                className="absolute -bottom-1 -right-1 px-1.5 py-0 text-[9px]"
                title=".maFile привязан"
              >
                SDA
              </Badge>
            )}
          </div>

          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex items-center gap-2">
              <span className="truncate text-base font-semibold">
                {account.personaName ?? account.login}
              </span>
              {account.inLowPriority === 1 && (
                <Badge variant="destructive" title="В Low Priority">
                  <AlertOctagon className="mr-1 h-3 w-3" />
                  LP{" "}
                  {account.lowPriorityGamesRemaining !== null
                    ? `(${account.lowPriorityGamesRemaining})`
                    : ""}
                </Badge>
              )}
            </div>
            <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
              <span className="truncate">{account.login}</span>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  void navigator.clipboard?.writeText(account.login);
                }}
                className="opacity-60 hover:opacity-100"
                title="Скопировать логин"
              >
                <Copy className="h-3 w-3" />
              </button>
            </div>
            <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
              <span className="font-mono">
                {showPassword ? account.password : "•".repeat(Math.min(account.password.length, 8))}
              </span>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setShowPassword((v) => !v);
                }}
                className="opacity-60 hover:opacity-100"
                title={showPassword ? "Скрыть" : "Показать"}
              >
                {showPassword ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  void navigator.clipboard?.writeText(account.password);
                }}
                className="opacity-60 hover:opacity-100"
                title="Скопировать пароль"
              >
                <Copy className="h-3 w-3" />
              </button>
            </div>
            <div className="mt-1 flex flex-wrap gap-1 text-xs text-muted-foreground">
              {account.steamId64 && (
                <span title="SteamID64" className="rounded bg-muted/50 px-1.5 py-0.5 font-mono">
                  {account.steamId64}
                </span>
              )}
              {account.friendCode && (
                <span title="Dota Friend ID" className="rounded bg-muted/50 px-1.5 py-0.5 font-mono">
                  #{account.friendCode}
                </span>
              )}
            </div>
          </div>

          <RankBadge
            rankTier={account.rankTier}
            mmr={account.mmr}
            leaderboardRank={account.leaderboardRank}
          />
        </div>

        <div className="grid gap-2 md:grid-cols-2">
          <ScoreBar label="Поведение" score={account.behaviorScore} />
          <ScoreBar label="Общение" score={account.communicationScore} />
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {account.mmr !== null && (
            <Badge variant="secondary" className="font-mono">
              MMR {account.mmr}
            </Badge>
          )}
          {account.email && (
            <span className="flex items-center gap-1" title={account.email}>
              <Mail className="h-3 w-3" />
              <span className="max-w-[16ch] truncate">{account.email}</span>
            </span>
          )}
          {account.proxy && (
            <Badge variant="outline" title={account.proxy}>
              proxy
            </Badge>
          )}
          {account.tags.map((tag) => (
            <Badge key={tag} variant="outline">
              #{tag}
            </Badge>
          ))}
          {account.notes && (
            <span className="flex items-center gap-1" title={account.notes}>
              <StickyNote className="h-3 w-3" />
              <span className="max-w-[20ch] truncate">{account.notes}</span>
            </span>
          )}
          <span className="ml-auto">Чек: {formatRelativeTime(account.lastCheckedAt)}</span>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="default" onClick={() => onLaunchOverplus?.(account.id)}>
            <Play className="h-3 w-3" />
            Старт + Overplus
          </Button>
          <Button size="sm" variant="outline" onClick={() => onLaunch?.(account.id)}>
            Старт Steam
          </Button>
          <Button size="sm" variant="ghost" onClick={() => onCheck?.(account.id)}>
            <RefreshCcw className="h-3 w-3" />
            Перечекать
          </Button>
          {account.hasMaFile === 1 && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onDeepCheck?.(account.id)}
              title="Логин в Steam → STRATZ → public refresh"
            >
              <ShieldCheck className="h-3 w-3" />
              Deep Check
            </Button>
          )}
          {account.hasMaFile === 1 && (
            <Button size="sm" variant="ghost" onClick={() => onShowMaCode?.(account.id)}>
              <KeyRound className="h-3 w-3" />
              2FA
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => onShowDetails?.(account.id)}>
            Детали
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto text-destructive hover:bg-destructive/10"
            onClick={() => onDelete?.(account.id)}
          >
            <Trash2 className="h-3 w-3" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
