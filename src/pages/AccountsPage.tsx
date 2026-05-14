import { useEffect, useMemo, useState } from "react";
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, arrayMove, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { Plus, RefreshCw, Search, Settings, Upload, LogOut, FolderInput } from "lucide-react";
import { useAccounts } from "@/store/accounts";
import { useVault } from "@/store/vault";
import { AccountCard } from "@/components/AccountCard";
import { AddAccountDialog } from "@/components/AddAccountDialog";
import { ImportDialog } from "@/components/ImportDialog";
import { SettingsDialog } from "@/components/SettingsDialog";
import { MaCodeDialog } from "@/components/MaCodeDialog";
import { AccountDetailsDialog } from "@/components/AccountDetailsDialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { api } from "@/lib/api";

export function AccountsPage(): React.JSX.Element {
  const {
    accounts,
    loading,
    load,
    reorder,
    checkOne,
    checkAll,
    deepCheck,
    remove,
    search,
    setSearch,
    tagFilter,
    setTagFilter,
    sortKey,
    setSortKey,
  } = useAccounts();
  const lock = useVault((s) => s.lock);
  const [addOpen, setAddOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [maForAccount, setMaForAccount] = useState<string | null>(null);
  const [detailsFor, setDetailsFor] = useState<string | null>(null);
  const [bulkChecking, setBulkChecking] = useState(false);

  useEffect(() => {
    void load();
  }, [load]);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const allTags = useMemo(() => {
    const set = new Set<string>();
    accounts.forEach((a) => a.tags.forEach((t) => set.add(t)));
    return Array.from(set).sort();
  }, [accounts]);

  const filtered = useMemo(() => {
    let list = accounts;
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(
        (a) =>
          a.login.toLowerCase().includes(q) ||
          (a.personaName ?? "").toLowerCase().includes(q) ||
          (a.notes ?? "").toLowerCase().includes(q) ||
          a.tags.some((t) => t.toLowerCase().includes(q)),
      );
    }
    if (tagFilter) {
      list = list.filter((a) => a.tags.includes(tagFilter));
    }
    if (sortKey !== "manual") {
      const sorted = [...list];
      sorted.sort((a, b) => {
        switch (sortKey) {
          case "mmr":
            return (b.mmr ?? -1) - (a.mmr ?? -1);
          case "behavior":
            return (b.behaviorScore ?? -1) - (a.behaviorScore ?? -1);
          case "comm":
            return (b.communicationScore ?? -1) - (a.communicationScore ?? -1);
          case "login":
            return a.login.localeCompare(b.login);
          case "lastCheck":
            return (b.lastCheckedAt ?? 0) - (a.lastCheckedAt ?? 0);
          default:
            return 0;
        }
      });
      return sorted;
    }
    return list;
  }, [accounts, search, tagFilter, sortKey]);

  const onDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const ids = accounts.map((a) => a.id);
    const oldIdx = ids.indexOf(active.id as string);
    const newIdx = ids.indexOf(over.id as string);
    if (oldIdx < 0 || newIdx < 0) return;
    const next = arrayMove(ids, oldIdx, newIdx);
    void reorder(next);
  };

  const onBulkCheck = async () => {
    setBulkChecking(true);
    try {
      await checkAll();
    } finally {
      setBulkChecking(false);
    }
  };

  const onLaunch = async (id: string) => {
    await api.launcher.startSteam(id);
  };

  const onDeepCheck = async (id: string) => {
    const result = await deepCheck(id);
    if (!result.ok) {
      window.alert(`Deep check failed:\n${result.error ?? "unknown error"}\n\nSteps:\n${result.steps.join("\n")}`);
    } else if (result.steps.length) {
      console.info("Deep check steps:", result.steps);
    }
  };

  const onLaunchOverplus = async (id: string) => {
    await api.launcher.startWithOverplus(id);
  };

  const onDelete = async (id: string) => {
    if (!confirm("Удалить аккаунт из менеджера?")) return;
    await remove(id);
  };

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-30 border-b border-border bg-background/95 backdrop-blur">
        <div className="container flex h-14 items-center gap-3">
          <span className="text-lg font-bold tracking-tight text-primary">d2smurf</span>
          <Badge variant="secondary" className="font-mono text-[10px]">
            {accounts.length} акк
          </Badge>
          <div className="relative ml-4 flex-1 max-w-md">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Поиск: логин, ник, теги..."
              className="pl-9"
            />
          </div>
          <select
            value={sortKey}
            onChange={(e) => setSortKey(e.target.value as typeof sortKey)}
            className="h-9 rounded-md border border-input bg-background px-2 text-sm"
          >
            <option value="manual">Порядок: ручной</option>
            <option value="mmr">по MMR</option>
            <option value="behavior">по поведению</option>
            <option value="comm">по общению</option>
            <option value="login">по логину</option>
            <option value="lastCheck">по дате чека</option>
          </select>
          <Button size="sm" variant="default" onClick={() => setAddOpen(true)}>
            <Plus className="h-4 w-4" /> Аккаунт
          </Button>
          <Button size="sm" variant="outline" onClick={() => setImportOpen(true)}>
            <Upload className="h-4 w-4" /> Импорт
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={async () => {
              const result = await api.import.pickFolder();
              if (result.ok && result.path) {
                await api.import.mafileFolder(result.path);
                await load();
              }
            }}
          >
            <FolderInput className="h-4 w-4" /> .maFile папка
          </Button>
          <Button size="sm" variant="ghost" onClick={onBulkCheck} disabled={bulkChecking || loading}>
            <RefreshCw className={`h-4 w-4 ${bulkChecking ? "animate-spin" : ""}`} />
            Чек всех
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setSettingsOpen(true)}>
            <Settings className="h-4 w-4" />
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void lock()}>
            <LogOut className="h-4 w-4" />
          </Button>
        </div>
        {allTags.length > 0 && (
          <div className="container flex h-10 flex-wrap items-center gap-2 pb-2 text-xs text-muted-foreground">
            <span>Теги:</span>
            <button
              type="button"
              onClick={() => setTagFilter(null)}
              className={`rounded-full border px-2 py-0.5 ${
                tagFilter === null ? "border-primary text-primary" : "border-border"
              }`}
            >
              все
            </button>
            {allTags.map((tag) => (
              <button
                key={tag}
                type="button"
                onClick={() => setTagFilter(tagFilter === tag ? null : tag)}
                className={`rounded-full border px-2 py-0.5 ${
                  tagFilter === tag ? "border-primary text-primary" : "border-border"
                }`}
              >
                #{tag}
              </button>
            ))}
          </div>
        )}
      </header>

      <main className="container flex-1 py-6">
        {filtered.length === 0 ? (
          <div className="grid place-items-center rounded-xl border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
            <div className="space-y-2">
              <p>Пока пусто. Добавьте первый аккаунт или импортируйте `.txt`.</p>
              <div className="flex justify-center gap-2 pt-2">
                <Button onClick={() => setAddOpen(true)}>
                  <Plus className="h-4 w-4" /> Добавить
                </Button>
                <Button variant="outline" onClick={() => setImportOpen(true)}>
                  <Upload className="h-4 w-4" /> Импорт
                </Button>
              </div>
            </div>
          </div>
        ) : (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext
              items={filtered.map((a) => a.id)}
              strategy={verticalListSortingStrategy}
            >
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-2">
                {filtered.map((account) => (
                  <AccountCard
                    key={account.id}
                    account={account}
                    draggable={sortKey === "manual" && !search && !tagFilter}
                    onCheck={(id) => void checkOne(id)}
                    onDeepCheck={(id) => void onDeepCheck(id)}
                    onLaunch={(id) => void onLaunch(id)}
                    onLaunchOverplus={(id) => void onLaunchOverplus(id)}
                    onDelete={(id) => void onDelete(id)}
                    onShowDetails={(id) => setDetailsFor(id)}
                    onShowMaCode={(id) => setMaForAccount(id)}
                  />
                ))}
              </div>
            </SortableContext>
          </DndContext>
        )}
      </main>

      <AddAccountDialog open={addOpen} onOpenChange={setAddOpen} />
      <ImportDialog open={importOpen} onOpenChange={setImportOpen} />
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
      <MaCodeDialog accountId={maForAccount} onOpenChange={(o) => !o && setMaForAccount(null)} />
      <AccountDetailsDialog accountId={detailsFor} onOpenChange={(o) => !o && setDetailsFor(null)} />
    </div>
  );
}
