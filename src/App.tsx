import { useEffect } from "react";
import { UnlockPage } from "@/pages/UnlockPage";
import { AccountsPage } from "@/pages/AccountsPage";
import { useVault } from "@/store/vault";
import { useSettings } from "@/store/settings";

export function App(): React.JSX.Element {
  const { isUnlocked, refresh } = useVault();
  const loadSettings = useSettings((s) => s.load);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (isUnlocked) {
      void loadSettings();
    }
  }, [isUnlocked, loadSettings]);

  useEffect(() => {
    // Apply theme from settings to <html> class.
    const root = document.documentElement;
    root.classList.add("dark");
  }, []);

  if (!isUnlocked) return <UnlockPage />;
  return <AccountsPage />;
}
