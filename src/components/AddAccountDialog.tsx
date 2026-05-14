import { Paperclip, X } from "lucide-react";
import { useState } from "react";
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
import { api } from "@/lib/api";
import { useAccounts } from "@/store/accounts";

interface PendingMaFile {
  content: string;
  filePath?: string;
  accountName?: string;
}

/**
 * Best-effort peek into a .maFile's JSON to surface the account name to the
 * user. We don't validate fully here — the main process re-parses on attach.
 */
function peekMaFile(content: string): { accountName?: string } {
  try {
    const obj = JSON.parse(content) as Record<string, unknown>;
    const name =
      (obj["account_name"] as string | undefined) ??
      (obj["AccountName"] as string | undefined) ??
      (obj["accountName"] as string | undefined);
    return { accountName: name };
  } catch {
    return {};
  }
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AddAccountDialog({ open, onOpenChange }: Props): React.JSX.Element {
  const create = useAccounts((s) => s.create);
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [email, setEmail] = useState("");
  const [emailPassword, setEmailPassword] = useState("");
  const [proxy, setProxy] = useState("");
  const [tags, setTags] = useState("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [maFile, setMaFile] = useState<PendingMaFile | null>(null);
  const [maError, setMaError] = useState<string | null>(null);

  const reset = () => {
    setLogin("");
    setPassword("");
    setEmail("");
    setEmailPassword("");
    setProxy("");
    setTags("");
    setNotes("");
    setError(null);
    setMaFile(null);
    setMaError(null);
  };

  const onPickMaFile = async () => {
    setMaError(null);
    const pick = await api.import.pickMaFile();
    if (!pick.ok || !pick.content) {
      return;
    }
    const peek = peekMaFile(pick.content);
    setMaFile({
      content: pick.content,
      filePath: pick.filePath,
      accountName: peek.accountName,
    });
    if (peek.accountName && !login.trim()) {
      setLogin(peek.accountName);
    }
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setMaError(null);
    setSubmitting(true);
    try {
      const tagList = tags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      const created = await create({
        login,
        password,
        email: email || null,
        emailPassword: emailPassword || null,
        proxy: proxy || null,
        notes: notes || null,
        tags: tagList,
      });
      if (maFile) {
        const attach = await api.import.mafile(maFile.content, created.id);
        if (!attach.ok) {
          setMaError(
            `Аккаунт создан, но .maFile не привязался: ${attach.error ?? "unknown error"}`,
          );
          await useAccounts.getState().load();
          return;
        }
        await useAccounts.getState().load();
      }
      reset();
      onOpenChange(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Добавить аккаунт</DialogTitle>
          <DialogDescription>
            Минимум — логин и пароль от Steam. Остальное опционально.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="grid gap-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label>Логин Steam</Label>
              <Input value={login} onChange={(e) => setLogin(e.target.value)} required autoFocus />
            </div>
            <div className="space-y-1">
              <Label>Пароль Steam</Label>
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label>Email</Label>
              <Input value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>Пароль от email</Label>
              <Input
                type="password"
                value={emailPassword}
                onChange={(e) => setEmailPassword(e.target.value)}
              />
            </div>
          </div>
          <div className="space-y-1">
            <Label>Прокси (необязательно)</Label>
            <Input
              value={proxy}
              onChange={(e) => setProxy(e.target.value)}
              placeholder="host:port:user:pass"
            />
          </div>
          <div className="space-y-1">
            <Label>Теги (через запятую)</Label>
            <Input
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="фарм, на продажу, для кента"
            />
          </div>
          <div className="space-y-1">
            <Label>Заметки</Label>
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} />
          </div>
          <div className="space-y-1">
            <Label>Steam Guard / .maFile (опционально)</Label>
            {maFile ? (
              <div className="flex items-center justify-between gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">
                <div className="flex min-w-0 flex-col">
                  <span className="truncate font-medium">
                    {maFile.accountName ?? "(без account_name)"}
                  </span>
                  {maFile.filePath && (
                    <span className="truncate text-xs text-muted-foreground">
                      {maFile.filePath}
                    </span>
                  )}
                  {maFile.accountName && login && maFile.accountName !== login && (
                    <span className="text-xs text-amber-500">
                      Внимание: логин в .maFile («{maFile.accountName}») не совпадает с
                      введённым «{login}».
                    </span>
                  )}
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => setMaFile(null)}
                  title="Открепить"
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            ) : (
              <Button type="button" variant="outline" onClick={onPickMaFile} className="w-full">
                <Paperclip className="h-4 w-4" />
                Прикрепить .maFile
              </Button>
            )}
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          {maError && <p className="text-sm text-amber-500">{maError}</p>}
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                reset();
                onOpenChange(false);
              }}
            >
              Отмена
            </Button>
            <Button type="submit" disabled={submitting || !login || !password}>
              {submitting ? "Сохраняю..." : "Добавить"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
