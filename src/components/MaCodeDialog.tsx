import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { api } from "@/lib/api";
import { Copy, RefreshCcw } from "lucide-react";

interface Props {
  accountId: string | null;
  onOpenChange: (open: boolean) => void;
}

export function MaCodeDialog({ accountId, onOpenChange }: Props): React.JSX.Element {
  const [code, setCode] = useState<string | null>(null);
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    const refresh = async () => {
      if (!accountId) return;
      const result = await api.sda.generateCode(accountId);
      if (result.ok && result.code) {
        setCode(result.code);
        setSecondsLeft(result.secondsLeft ?? null);
        setError(null);
      } else {
        setError(result.error ?? "Не удалось получить код");
        setCode(null);
      }
    };
    void refresh();
    if (accountId) {
      timer = setInterval(refresh, 1000);
    }
    return () => {
      if (timer) clearInterval(timer);
    };
  }, [accountId]);

  return (
    <Dialog open={accountId !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Steam Guard код</DialogTitle>
          <DialogDescription>Код обновляется каждые 30 секунд.</DialogDescription>
        </DialogHeader>
        {error && <p className="text-sm text-destructive">{error}</p>}
        {code && (
          <div className="space-y-3 text-center">
            <div className="font-mono text-5xl font-bold tracking-widest text-primary">{code}</div>
            {secondsLeft !== null && (
              <p className="text-xs text-muted-foreground">
                Истечёт через {secondsLeft} сек <RefreshCcw className="inline h-3 w-3" />
              </p>
            )}
            <Button
              variant="outline"
              className="w-full"
              onClick={() => {
                if (code) void navigator.clipboard?.writeText(code);
              }}
            >
              <Copy className="h-3 w-3" />
              Скопировать
            </Button>
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Закрыть
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
