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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useAccounts } from "@/store/accounts";
import type { AccountRow } from "@/lib/api";
import { api } from "@/lib/api";

interface Props {
  accountId: string | null;
  onOpenChange: (open: boolean) => void;
}

export function AccountDetailsDialog({ accountId, onOpenChange }: Props): React.JSX.Element {
  const accounts = useAccounts((s) => s.accounts);
  const update = useAccounts((s) => s.update);
  const [draft, setDraft] = useState<AccountRow | null>(null);
  const [tags, setTags] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [maInfo, setMaInfo] = useState<string | null>(null);
  const [proxyChecking, setProxyChecking] = useState(false);
  const [proxyInfo, setProxyInfo] = useState<string | null>(null);

  useEffect(() => {
    if (!accountId) {
      setDraft(null);
      return;
    }
    const found = accounts.find((a) => a.id === accountId) ?? null;
    setDraft(found ? { ...found } : null);
    setTags(found?.tags?.join(", ") ?? "");
    setError(null);
    setMaInfo(null);
    setProxyInfo(null);
  }, [accountId, accounts]);

  const onSave = async () => {
    if (!draft) return;
    setSaving(true);
    setError(null);
    try {
      const tagList = tags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      await update(draft.id, {
        password: draft.password,
        email: draft.email,
        emailPassword: draft.emailPassword,
        proxy: draft.proxy,
        notes: draft.notes,
        tags: tagList,
      });
      onOpenChange(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const onPickMaFile = async () => {
    if (!draft) return;
    const pick = await api.import.pickMaFile();
    if (!pick.ok || !pick.content) {
      setMaInfo("Файл не выбран.");
      return;
    }
    const result = await api.import.mafile(pick.content, draft.id);
    if (result.ok) {
      setMaInfo("Привязан .maFile.");
    } else {
      setMaInfo(result.error ?? "Ошибка");
    }
  };

  const onTestProxy = async () => {
    if (!draft?.proxy?.trim()) return;
    setProxyChecking(true);
    setProxyInfo(null);
    const result = await api.proxy.test(draft.proxy.trim());
    setProxyInfo(result.ok ? `IP через proxy: ${result.ip}` : `Proxy не работает: ${result.error}`);
    setProxyChecking(false);
  };

  if (!draft) return <></>;

  return (
    <Dialog open={accountId !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{draft.login}</DialogTitle>
          <DialogDescription>
            SteamID64: <code>{draft.steamId64 ?? "—"}</code>
            {draft.friendCode ? ` • Friend ID: #${draft.friendCode}` : ""}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label>Пароль Steam</Label>
              <Input
                value={draft.password}
                onChange={(e) => setDraft({ ...draft, password: e.target.value })}
              />
            </div>
            <div className="space-y-1">
              <Label>Email</Label>
              <Input
                value={draft.email ?? ""}
                onChange={(e) => setDraft({ ...draft, email: e.target.value })}
              />
            </div>
            <div className="space-y-1">
              <Label>Пароль от email</Label>
              <Input
                value={draft.emailPassword ?? ""}
                onChange={(e) => setDraft({ ...draft, emailPassword: e.target.value })}
              />
            </div>
            <div className="space-y-1">
              <Label>Прокси</Label>
              <div className="flex gap-2">
                <Input
                  value={draft.proxy ?? ""}
                  onChange={(e) => {
                    setDraft({ ...draft, proxy: e.target.value });
                    setProxyInfo(null);
                  }}
                  placeholder="http://user:pass@host:port или socks5://127.0.0.1:40000"
                />
                <Button
                  type="button"
                  variant="outline"
                  onClick={onTestProxy}
                  disabled={!draft.proxy?.trim() || proxyChecking}
                >
                  {proxyChecking ? "Проверяю..." : "Проверить"}
                </Button>
              </div>
              {proxyInfo && <p className="text-xs text-muted-foreground">{proxyInfo}</p>}
            </div>
          </div>
          <div className="space-y-1">
            <Label>Теги</Label>
            <Input value={tags} onChange={(e) => setTags(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label>Заметки</Label>
            <Textarea
              value={draft.notes ?? ""}
              onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
              rows={3}
            />
          </div>
          <div className="rounded-md border border-border bg-muted/30 p-3 text-xs">
            <div className="mb-2 flex items-center justify-between">
              <strong>Steam Guard / .maFile</strong>
              {draft.hasMaFile === 1 ? (
                <span className="text-emerald-400">Привязан</span>
              ) : (
                <span className="text-muted-foreground">Не привязан</span>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={onPickMaFile}>
                Привязать .maFile
              </Button>
              {draft.hasMaFile === 1 && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    void api.sda.exportMaFile(draft.id);
                  }}
                >
                  Экспортировать .maFile
                </Button>
              )}
            </div>
            {maInfo && <p className="mt-2 text-muted-foreground">{maInfo}</p>}
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Закрыть
          </Button>
          <Button onClick={onSave} disabled={saving}>
            {saving ? "Сохраняю..." : "Сохранить"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
