import { Copy, ShieldAlert } from "lucide-react";
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
import { api } from "@/lib/api";
import { useAccounts } from "@/store/accounts";

interface Props {
  accountId: string | null;
  onOpenChange: (open: boolean) => void;
}

type Phase =
  | { name: "intro" }
  | { name: "starting" }
  | { name: "code-prompt"; sessionId: string; revocationCode?: string; maskedPhone?: string }
  | { name: "submitting"; sessionId: string; revocationCode?: string }
  | { name: "success"; revocationCode?: string }
  | { name: "error"; message: string; revocationCode?: string };

export function SdaRegisterDialog({ accountId, onOpenChange }: Props): React.JSX.Element {
  const reloadAccounts = useAccounts((s) => s.load);
  const [phase, setPhase] = useState<Phase>({ name: "intro" });
  const [activationCode, setActivationCode] = useState("");

  useEffect(() => {
    if (accountId === null) {
      // dialog closed — reset
      setPhase({ name: "intro" });
      setActivationCode("");
    }
  }, [accountId]);

  const close = async () => {
    // If we're mid-flow, cancel server-side session so Steam-user disconnects.
    if (phase.name === "code-prompt") {
      await api.sda.cancelRegistration(phase.sessionId);
    }
    onOpenChange(false);
  };

  const start = async () => {
    if (!accountId) return;
    setPhase({ name: "starting" });
    const result = await api.sda.startRegistration(accountId);
    if (!result.ok || !result.sessionId) {
      setPhase({
        name: "error",
        message: result.error ?? "Не удалось начать привязку SDA.",
        revocationCode: result.revocationCode,
      });
      return;
    }
    setPhase({
      name: "code-prompt",
      sessionId: result.sessionId,
      revocationCode: result.revocationCode,
      maskedPhone: result.maskedPhone,
    });
  };

  const submit = async () => {
    if (phase.name !== "code-prompt") return;
    if (!activationCode.trim()) return;
    setPhase({
      name: "submitting",
      sessionId: phase.sessionId,
      revocationCode: phase.revocationCode,
    });
    const result = await api.sda.submitActivationCode(phase.sessionId, activationCode.trim());
    if (!result.ok) {
      setPhase({
        name: "error",
        message: result.error ?? "Steam отверг код.",
        revocationCode: result.revocationCode ?? phase.revocationCode,
      });
      return;
    }
    await reloadAccounts();
    setPhase({
      name: "success",
      revocationCode: result.revocationCode ?? phase.revocationCode,
    });
  };

  return (
    <Dialog open={accountId !== null} onOpenChange={(o) => !o && void close()}>
      <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Привязка SDA (Steam Guard Mobile)</DialogTitle>
          <DialogDescription>
            Менеджер залогинится в Steam и попросит Steam сгенерировать секреты мобильного
            аутентификатора. Steam пришлёт SMS с кодом активации.
          </DialogDescription>
        </DialogHeader>

        {phase.name === "intro" && (
          <div className="space-y-3 text-sm">
            <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-amber-300">
              <p className="font-medium">Что нужно знать:</p>
              <ul className="mt-2 list-disc space-y-1 pl-4">
                <li>
                  Steam поставит <strong>15-дневный hold</strong> на трейды и маркет — обойти
                  нельзя, это политика Valve.
                </li>
                <li>
                  На аккаунте должен быть привязан <strong>подтверждённый номер телефона</strong>.
                  Один номер = один SDA-аккаунт.
                </li>
                <li>
                  После успеха в карточке появится <strong>revocation code (R12345)</strong> —{" "}
                  обязательно сохрани его, иначе отвязать SDA будет очень больно.
                </li>
                <li>
                  Если на аккаунте уже включён мобильный аутентификатор — менеджер его не
                  заменяет, нужно сначала отключить через Steam.
                </li>
              </ul>
            </div>
            <Button className="w-full" onClick={() => void start()}>
              Начать привязку
            </Button>
          </div>
        )}

        {phase.name === "starting" && (
          <div className="py-6 text-center text-sm text-muted-foreground">
            Логинимся в Steam и запрашиваем секреты… (до 30 сек)
          </div>
        )}

        {phase.name === "code-prompt" && (
          <div className="space-y-4 text-sm">
            <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 p-3 text-emerald-300">
              <p>
                Steam отправил SMS с кодом активации
                {phase.maskedPhone ? ` на номер ${phase.maskedPhone}` : ""}.
              </p>
              <p className="mt-1 text-xs">Введи код сюда чтобы завершить привязку.</p>
            </div>

            {phase.revocationCode && <RevocationCodeBox code={phase.revocationCode} preview />}

            <div className="space-y-1">
              <Label>SMS-код активации</Label>
              <Input
                value={activationCode}
                onChange={(e) => setActivationCode(e.target.value)}
                placeholder="например: ABC12"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter" && activationCode.trim()) void submit();
                }}
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => void close()}>
                Отменить
              </Button>
              <Button onClick={() => void submit()} disabled={!activationCode.trim()}>
                Подтвердить код
              </Button>
            </div>
          </div>
        )}

        {phase.name === "submitting" && (
          <div className="py-6 text-center text-sm text-muted-foreground">
            Отправляю код активации в Steam…
          </div>
        )}

        {phase.name === "success" && (
          <div className="space-y-3 text-sm">
            <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 p-3 text-emerald-300">
              SDA успешно привязан. Steam Guard теперь будет приходить с этого менеджера.
            </div>
            {phase.revocationCode && <RevocationCodeBox code={phase.revocationCode} />}
            <DialogFooter>
              <Button onClick={() => onOpenChange(false)}>Готово</Button>
            </DialogFooter>
          </div>
        )}

        {phase.name === "error" && (
          <div className="space-y-3 text-sm">
            <div className="whitespace-pre-line rounded-md border border-destructive/40 bg-destructive/10 p-3 text-destructive">
              <ShieldAlert className="mb-1 h-4 w-4" />
              {phase.message}
            </div>
            {phase.revocationCode && <RevocationCodeBox code={phase.revocationCode} />}
            <DialogFooter>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                Закрыть
              </Button>
              {phase.name === "error" && (
                <Button onClick={() => setPhase({ name: "intro" })}>Попробовать снова</Button>
              )}
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function RevocationCodeBox({
  code,
  preview = false,
}: {
  code: string;
  preview?: boolean;
}): React.JSX.Element {
  return (
    <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-amber-300">
      <p className="text-xs font-medium uppercase tracking-wide text-amber-200">
        Revocation code {preview ? "(сохрани прямо сейчас!)" : ""}
      </p>
      <div className="mt-1 flex items-center gap-2">
        <code className="flex-1 select-all font-mono text-lg font-bold">{code}</code>
        <Button
          size="sm"
          variant="outline"
          onClick={() => void navigator.clipboard?.writeText(code)}
          title="Скопировать"
        >
          <Copy className="h-3 w-3" />
        </Button>
      </div>
      <p className="mt-1 text-xs text-amber-200/80">
        Понадобится для отвязки SDA в будущем. Без него Valve поставит 14-дневный кулдаун.
      </p>
    </div>
  );
}
