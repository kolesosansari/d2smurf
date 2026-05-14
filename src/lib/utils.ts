import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

export function formatRelativeTime(timestamp: number | null): string {
  if (!timestamp) return "никогда";
  const diff = Date.now() - timestamp;
  if (diff < 0) return "только что";
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "только что";
  if (minutes < 60) return `${minutes} мин назад`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ч назад`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} дн назад`;
  return new Date(timestamp).toLocaleDateString("ru-RU");
}

export function scoreColor(score: number | null | undefined): string {
  if (score === null || score === undefined) return "text-muted-foreground";
  if (score >= 9500) return "text-emerald-400";
  if (score >= 8000) return "text-amber-400";
  return "text-red-400";
}

export function scoreBg(score: number | null | undefined): string {
  if (score === null || score === undefined) return "bg-muted/50";
  if (score >= 9500) return "bg-emerald-500/15";
  if (score >= 8000) return "bg-amber-500/15";
  return "bg-red-500/15";
}
