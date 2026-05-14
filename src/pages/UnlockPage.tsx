import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useVault } from "@/store/vault";
import { ShieldCheck, KeyRound } from "lucide-react";

export function UnlockPage(): React.JSX.Element {
  const { isInitialized, refresh, initialize, unlock, error, loading } = useVault();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLocalError(null);
    if (!isInitialized) {
      if (password.length < 4) {
        setLocalError("Минимум 4 символа.");
        return;
      }
      if (password !== confirm) {
        setLocalError("Пароли не совпадают.");
        return;
      }
      await initialize(password);
    } else {
      await unlock(password);
    }
  };

  return (
    <div className="grid min-h-screen place-items-center bg-gradient-to-br from-background via-background to-primary/10 p-6">
      <div className="w-full max-w-md space-y-6 rounded-xl border border-border bg-card p-8 shadow-2xl">
        <div className="flex items-center gap-3 text-primary">
          <ShieldCheck className="h-8 w-8" />
          <h1 className="text-2xl font-bold tracking-tight">d2smurf</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          {isInitialized
            ? "Введите мастер-пароль, чтобы разблокировать ваше зашифрованное хранилище аккаунтов."
            : "Первый запуск. Придумайте мастер-пароль — без него хранилище не открыть. Восстановления нет."}
        </p>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="master">Мастер-пароль</Label>
            <Input
              id="master"
              type="password"
              autoFocus
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
            />
          </div>
          {!isInitialized && (
            <div className="space-y-2">
              <Label htmlFor="confirm">Повторите пароль</Label>
              <Input
                id="confirm"
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                placeholder="••••••••"
              />
            </div>
          )}
          {(error || localError) && (
            <p className="text-sm text-destructive">{localError ?? error}</p>
          )}
          <Button type="submit" className="w-full" disabled={loading || !password}>
            <KeyRound className="h-4 w-4" />
            {isInitialized ? "Разблокировать" : "Создать хранилище"}
          </Button>
        </form>
        <p className="text-center text-xs text-muted-foreground">
          AES-256 + SQLCipher. Все пароли, .maFile и токены хранятся локально.
        </p>
      </div>
    </div>
  );
}
