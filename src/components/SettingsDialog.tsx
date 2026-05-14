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
import { Separator } from "@/components/ui/separator";
import { useSettings } from "@/store/settings";
import { api } from "@/lib/api";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SettingsDialog({ open, onOpenChange }: Props): React.JSX.Element {
  const { settings, load, update } = useSettings();
  const [draft, setDraft] = useState(settings);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  useEffect(() => {
    setDraft(settings);
  }, [settings]);

  if (!draft) return <Dialog open={open} onOpenChange={onOpenChange}>{null as never}</Dialog>;

  const onSave = async () => {
    setSaving(true);
    try {
      await update(draft);
      onOpenChange(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Настройки</DialogTitle>
          <DialogDescription>
            Параметры приложения, пути к Steam/Overplus, ключи API, авточек.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <section className="space-y-2">
            <h3 className="text-sm font-semibold">Пути</h3>
            <div className="space-y-1">
              <Label>Steam.exe</Label>
              <Input
                value={draft.steamPath ?? ""}
                onChange={(e) => setDraft({ ...draft, steamPath: e.target.value })}
                placeholder="C:\\Program Files (x86)\\Steam\\steam.exe"
              />
            </div>
            <div className="space-y-1">
              <Label>Overplus.exe</Label>
              <Input
                value={draft.overplusPath ?? ""}
                onChange={(e) => setDraft({ ...draft, overplusPath: e.target.value })}
                placeholder="C:\\Users\\<user>\\AppData\\Local\\Programs\\Overplus\\Overplus.exe"
              />
            </div>
            <div className="space-y-1">
              <Label>Доп. опции запуска Dota 2</Label>
              <Input
                value={draft.dotaLaunchOptions}
                onChange={(e) => setDraft({ ...draft, dotaLaunchOptions: e.target.value })}
                placeholder="-novid -nojoy"
              />
            </div>
          </section>
          <Separator />
          <section className="space-y-2">
            <h3 className="text-sm font-semibold">API ключи</h3>
            <div className="space-y-1">
              <Label>Steam Web API key</Label>
              <Input
                value={draft.steamWebApiKey ?? ""}
                onChange={(e) => setDraft({ ...draft, steamWebApiKey: e.target.value })}
                placeholder="32-символьный ключ от steamcommunity.com/dev/apikey"
              />
            </div>
            <div className="space-y-1">
              <Label>STRATZ API key</Label>
              <Input
                value={draft.stratzApiKey ?? ""}
                onChange={(e) => setDraft({ ...draft, stratzApiKey: e.target.value })}
                placeholder="JWT-токен с stratz.com/api"
              />
            </div>
          </section>
          <Separator />
          <section className="space-y-2">
            <h3 className="text-sm font-semibold">Авточек</h3>
            <div className="flex items-center gap-3">
              <Label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={draft.autoCheckEnabled}
                  onChange={(e) => setDraft({ ...draft, autoCheckEnabled: e.target.checked })}
                />
                Включить авточек по расписанию
              </Label>
            </div>
            <div className="space-y-1">
              <Label>Интервал (часы)</Label>
              <Input
                type="number"
                min={1}
                max={24}
                value={draft.autoCheckIntervalHours}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    autoCheckIntervalHours: Math.max(1, parseInt(e.target.value || "1", 10)),
                  })
                }
              />
            </div>
          </section>
          <Separator />
          <section className="space-y-2">
            <h3 className="text-sm font-semibold">Бэкап</h3>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                void api.backup.export();
              }}
            >
              Экспортировать зашифрованную базу
            </Button>
          </section>
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
