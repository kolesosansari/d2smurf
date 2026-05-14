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
            Поддерживаются форматы: <code>login:password</code>,{" "}
            <code>login:password:email:emailPass</code>. Также можно вставить вручную.
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
            placeholder={"login1:password1\nlogin2:password2:email:emailPass"}
          />
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
