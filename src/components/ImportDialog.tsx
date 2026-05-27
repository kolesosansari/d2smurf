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
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { useDropzone } from "react-dropzone";
import { api } from "@/lib/api";
import { useAccounts } from "@/store/accounts";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const importPlaceholder = `jtugse1681:9XM9X2KKK35B:juliusgoodmanhlve@outlook.com:ZkjU6Tsfm0
LOGIN:ACxJo3J8
PASS:1nZ2yqCb
MAIL:sherwoodbudzynski1926@contemporafmli.ru
PASS:ibqhdsin7309
hh3533772----obr751050----JulianKozeypsl@outlook.com----iaxlpcxvbf37184
8ulpFtyrM 2FIuzna2yuQCCEi aboodqruskabkj@hotmail.com EZFahJCMuEg`;

export function ImportDialog({ open, onOpenChange }: Props): React.JSX.Element {
  const load = useAccounts((s) => s.load);
  const [content, setContent] = useState("");
  const [tags, setTags] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    accept: { "text/plain": [".txt"] },
    multiple: false,
    onDrop: async (files) => {
      if (files.length === 0) return;
      const file = files[0];
      const text = await file.text();
      setContent(text);
      setInfo(`Загружено из ${file.name}: ${text.split(/\r?\n/).filter(Boolean).length} строк`);
    },
  });

  const onSubmit = async () => {
    if (!content.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const tagList = tags.split(",").map((t) => t.trim()).filter(Boolean);
      const result = await api.import.txt(content, tagList);
      setInfo(`Добавлено: ${result.added}, пропущено: ${result.skipped}`);
      if (result.errors.length > 0) setError(result.errors.slice(0, 5).join("\n"));
      await load();
      if (result.added > 0 && result.errors.length === 0) {
        onOpenChange(false);
        setContent("");
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Импорт аккаунтов из .txt</DialogTitle>
          <DialogDescription>
            Можно перетащить <code>.txt</code> или вставить аккаунты из FanPay вручную.
            Поддерживаются разделители <code>:</code>, <code>----</code>, пробелы, запятые и блоки{" "}
            <code>LOGIN/PASS/MAIL/PASS</code>.
          </DialogDescription>
        </DialogHeader>
        <div
          {...getRootProps()}
          className={`grid place-items-center rounded-md border-2 border-dashed p-6 text-center text-sm transition-colors ${
            isDragActive
              ? "border-primary bg-primary/10 text-primary-foreground"
              : "border-border text-muted-foreground"
          }`}
        >
          <input {...getInputProps()} />
          <p>
            Перетащите <code>.txt</code> сюда, или кликните чтобы выбрать. Можно также вставить
            строки ниже.
          </p>
        </div>
        <div className="space-y-1">
          <Label>Строки</Label>
          <Textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={8}
            className="font-mono text-xs"
            placeholder={importPlaceholder}
          />
          <p className="text-xs text-muted-foreground">
            Для блока <code>LOGIN/PASS/MAIL/PASS</code> первый <code>PASS</code> считается паролем
            Steam, второй после <code>MAIL</code> - паролем почты.
          </p>
        </div>
        <div className="space-y-1">
          <Label>Теги для импортируемых (через запятую)</Label>
          <Input
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            placeholder="свежак, для кента"
          />
        </div>
        {info && <p className="text-sm text-emerald-400">{info}</p>}
        {error && <pre className="whitespace-pre-wrap text-sm text-destructive">{error}</pre>}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Закрыть
          </Button>
          <Button onClick={onSubmit} disabled={submitting || !content.trim()}>
            {submitting ? "Импортирую..." : "Импортировать"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
