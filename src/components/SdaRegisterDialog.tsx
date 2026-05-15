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
import type { SdaRegistrationResult, SdaSteamGuardType } from "@shared/types";

interface Props {
  accountId: string | null;
  onOpenChange: (open: boolean) => void;
}

type Phase =
  | { name: "intro" }
  | { name: "starting" }
  | {
      name: "steam-guard";
      sessionId: string;
      guardType?: SdaSteamGuardType;
      guardDetail?: string;
    }
  | { name: "phone-number"; sessionId: string }
  | { name: "phone-email"; sessionId: string }
  | { name: "phone-sms"; sessionId: string }
  | { name: "code-prompt"; sessionId: string; revocationCode?: string; maskedPhone?: string }
  | { name: "submitting"; sessionId: string; revocationCode?: string }
  | { name: "success"; revocationCode?: string }
  | {
      name: "error";
      message: string;
      revocationCode?: string;
      sessionId?: string;
      limitedAccount?: boolean;
    };

function sessionIdFromPhase(phase: Phase): string | undefined {
  if (
    phase.name === "steam-guard" ||
    phase.name === "phone-number" ||
    phase.name === "phone-email" ||
    phase.name === "phone-sms" ||
    phase.name === "code-prompt" ||
    phase.name === "submitting" ||
    phase.name === "error"
  ) {
    return phase.sessionId;
  }
  return undefined;
}

function steamGuardLabel(type?: SdaSteamGuardType): string {
  switch (type) {
    case "device":
      return "Код из текущего мобильного Steam Guard";
    case "emailConfirmation":
      return "Подтверждение входа по ссылке в email";
    case "deviceConfirmation":
      return "Подтверждение входа в мобильном приложении Steam";
    case "email":
    default:
      return "Код Steam Guard из email";
  }
}

interface PhoneCountry {
  iso: string;
  name: string;
  dial: string;
  localLength: number;
  placeholder: string;
}

const PHONE_COUNTRIES: PhoneCountry[] = [
  { iso: "KZ", name: "Казахстан", dial: "7", localLength: 10, placeholder: "778 560 7889" },
  { iso: "RU", name: "Россия", dial: "7", localLength: 10, placeholder: "999 123 4567" },
  { iso: "UA", name: "Украина", dial: "380", localLength: 9, placeholder: "67 123 4567" },
  { iso: "BY", name: "Беларусь", dial: "375", localLength: 9, placeholder: "29 123 4567" },
  { iso: "UZ", name: "Узбекистан", dial: "998", localLength: 9, placeholder: "90 123 4567" },
  { iso: "KG", name: "Кыргызстан", dial: "996", localLength: 9, placeholder: "555 123456" },
  { iso: "TJ", name: "Таджикистан", dial: "992", localLength: 9, placeholder: "92 123 4567" },
  { iso: "AM", name: "Армения", dial: "374", localLength: 8, placeholder: "91 123456" },
  { iso: "AZ", name: "Азербайджан", dial: "994", localLength: 9, placeholder: "50 123 4567" },
  { iso: "GE", name: "Грузия", dial: "995", localLength: 9, placeholder: "555 12 34 56" },
  { iso: "MD", name: "Молдова", dial: "373", localLength: 8, placeholder: "69 123456" },
  { iso: "US", name: "США", dial: "1", localLength: 10, placeholder: "201 555 0123" },
  { iso: "GB", name: "Великобритания", dial: "44", localLength: 10, placeholder: "7400 123456" },
  { iso: "DE", name: "Германия", dial: "49", localLength: 10, placeholder: "151 12345678" },
  { iso: "PL", name: "Польша", dial: "48", localLength: 9, placeholder: "512 345 678" },
  { iso: "TR", name: "Турция", dial: "90", localLength: 10, placeholder: "501 234 5678" },
  { iso: "IN", name: "Индия", dial: "91", localLength: 10, placeholder: "98765 43210" },
  { iso: "ID", name: "Индонезия", dial: "62", localLength: 10, placeholder: "812 3456 7890" },
  { iso: "PH", name: "Филиппины", dial: "63", localLength: 10, placeholder: "917 123 4567" },
  { iso: "VN", name: "Вьетнам", dial: "84", localLength: 9, placeholder: "91 234 5678" },
];

function countryByIso(iso: string): PhoneCountry {
  return PHONE_COUNTRIES.find((country) => country.iso === iso) ?? PHONE_COUNTRIES[0];
}

function cleanPhoneInput(value: string): string {
  return value.replace(/[^0-9\s()-]/g, "");
}

function phoneForSteam(country: PhoneCountry, localOrFullNumber: string): string {
  let digits = localOrFullNumber.replace(/\D/g, "");
  if (!digits) return "";
  if (digits.startsWith(country.dial) && digits.length > country.localLength) {
    digits = digits.slice(country.dial.length);
  } else if (digits.startsWith("0") && digits.length > country.localLength) {
    digits = digits.slice(1);
  }
  return `+${country.dial}${digits}`;
}

function PhoneInputFields({
  countryIso,
  phoneNumber,
  autoFocus = false,
  onCountryChange,
  onPhoneChange,
}: {
  countryIso: string;
  phoneNumber: string;
  autoFocus?: boolean;
  onCountryChange: (countryIso: string) => void;
  onPhoneChange: (phoneNumber: string) => void;
}): React.JSX.Element {
  const country = countryByIso(countryIso);
  return (
    <div className="grid grid-cols-[4.5rem_1fr_9rem] gap-2">
      <div className="space-y-1">
        <Label>Код</Label>
        <div className="flex h-9 items-center rounded-md border border-input bg-muted/40 px-3 text-sm font-medium text-muted-foreground">
          +{country.dial}
        </div>
      </div>
      <div className="space-y-1">
        <Label>Номер без кода</Label>
        <Input
          value={phoneNumber}
          onChange={(e) => onPhoneChange(cleanPhoneInput(e.target.value))}
          placeholder={country.placeholder}
          autoFocus={autoFocus}
          inputMode="tel"
        />
      </div>
      <div className="space-y-1">
        <Label>Страна</Label>
        <select
          value={countryIso}
          onChange={(e) => onCountryChange(e.target.value)}
          className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
          title="Выбрать страну"
        >
          {PHONE_COUNTRIES.map((item) => (
            <option key={item.iso} value={item.iso}>
              {item.iso} +{item.dial}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

export function SdaRegisterDialog({ accountId, onOpenChange }: Props): React.JSX.Element {
  const reloadAccounts = useAccounts((s) => s.load);
  const [phase, setPhase] = useState<Phase>({ name: "intro" });
  const [phoneNumber, setPhoneNumber] = useState("");
  const [phoneCountryIso, setPhoneCountryIso] = useState("KZ");
  const [steamGuardCode, setSteamGuardCode] = useState("");
  const [phoneEmailToken, setPhoneEmailToken] = useState("");
  const [phoneEmailInfo, setPhoneEmailInfo] = useState<string | null>(null);
  const [phoneSmsCode, setPhoneSmsCode] = useState("");
  const [activationCode, setActivationCode] = useState("");

  useEffect(() => {
    if (accountId === null) {
      setPhase({ name: "intro" });
      setPhoneNumber("");
      setPhoneCountryIso("KZ");
      setSteamGuardCode("");
      setPhoneEmailToken("");
      setPhoneEmailInfo(null);
      setPhoneSmsCode("");
      setActivationCode("");
    }
  }, [accountId]);

  const close = async () => {
    const sessionId = sessionIdFromPhase(phase);
    if (sessionId && phase.name !== "success") {
      await api.sda.cancelRegistration(sessionId);
    }
    onOpenChange(false);
  };

  const applyResult = async (result: SdaRegistrationResult) => {
    if (!result.ok) {
      setPhase({
        name: "error",
        message: result.error ?? "Не удалось продолжить привязку SDA.",
        revocationCode: result.revocationCode,
        sessionId: result.sessionId,
        limitedAccount: result.limitedAccount,
      });
      return;
    }

    if (result.nextStep === "steamGuard" && result.sessionId) {
      setSteamGuardCode("");
      setPhase({
        name: "steam-guard",
        sessionId: result.sessionId,
        guardType: result.guardType,
        guardDetail: result.guardDetail,
      });
      return;
    }

    if (result.nextStep === "phoneNumber" && result.sessionId) {
      setPhase({ name: "phone-number", sessionId: result.sessionId });
      return;
    }

    if (result.nextStep === "phoneEmail" && result.sessionId) {
      setPhoneEmailToken("");
      setPhoneEmailInfo(
        "Открой письмо Steam и нажми ADD PHONE NUMBER. После этого вернись сюда и нажми кнопку проверки.",
      );
      setPhase({ name: "phone-email", sessionId: result.sessionId });
      return;
    }

    if (result.nextStep === "phoneSms" && result.sessionId) {
      setPhoneSmsCode("");
      setPhase({ name: "phone-sms", sessionId: result.sessionId });
      return;
    }

    if (result.nextStep === "activationCode" && result.sessionId) {
      setActivationCode("");
      setPhase({
        name: "code-prompt",
        sessionId: result.sessionId,
        revocationCode: result.revocationCode,
        maskedPhone: result.maskedPhone,
      });
      return;
    }

    if (result.nextStep === "complete") {
      await reloadAccounts();
      setPhase({ name: "success", revocationCode: result.revocationCode });
      return;
    }

    setPhase({ name: "error", message: "Steam вернул неизвестный следующий шаг." });
  };

  const start = async () => {
    if (!accountId) return;
    setPhase({ name: "starting" });
    const country = countryByIso(phoneCountryIso);
    const normalizedPhone = phoneForSteam(country, phoneNumber);
    const result = await api.sda.startRegistration(
      accountId,
      normalizedPhone
        ? {
            phoneNumber: normalizedPhone,
            phoneCountryCode: country.iso,
          }
        : undefined,
    );
    await applyResult(result);
  };

  const submitSteamGuard = async () => {
    if (phase.name !== "steam-guard" || !steamGuardCode.trim()) return;
    setPhase({ name: "starting" });
    const result = await api.sda.submitSteamGuardCode(phase.sessionId, steamGuardCode.trim());
    await applyResult(result);
  };

  const submitPhone = async () => {
    if (phase.name !== "phone-number" || !phoneNumber.trim()) return;
    setPhase({ name: "starting" });
    const country = countryByIso(phoneCountryIso);
    const result = await api.sda.submitPhoneNumber(
      phase.sessionId,
      phoneForSteam(country, phoneNumber),
      country.iso,
    );
    await applyResult(result);
  };

  const submitPhoneEmail = async () => {
    if (phase.name !== "phone-email" || !phoneEmailToken.trim()) return;
    setPhase({ name: "starting" });
    const result = await api.sda.confirmPhoneEmail(phase.sessionId, phoneEmailToken.trim());
    await applyResult(result);
  };

  const checkPhoneEmail = async () => {
    if (phase.name !== "phone-email") return;
    setPhoneEmailInfo("Проверяю подтверждение в Steam...");
    const result = await api.sda.checkPhoneEmail(phase.sessionId);
    if (result.ok && result.nextStep === "phoneEmail") {
      setPhoneEmailInfo(
        "Steam ещё ждёт подтверждение. Нажми ADD PHONE NUMBER в письме или подожди пару секунд и проверь снова.",
      );
      return;
    }
    await applyResult(result);
  };

  const submitPhoneSms = async () => {
    if (phase.name !== "phone-sms" || !phoneSmsCode.trim()) return;
    setPhase({ name: "starting" });
    const result = await api.sda.submitPhoneSms(phase.sessionId, phoneSmsCode.trim());
    await applyResult(result);
  };

  const submitActivation = async () => {
    if (phase.name !== "code-prompt" || !activationCode.trim()) return;
    setPhase({
      name: "submitting",
      sessionId: phase.sessionId,
      revocationCode: phase.revocationCode,
    });
    const result = await api.sda.submitActivationCode(phase.sessionId, activationCode.trim());
    await applyResult(result);
  };

  return (
    <Dialog open={accountId !== null} onOpenChange={(o) => !o && void close()}>
      <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Привязка SDA (Steam Guard Mobile)</DialogTitle>
          <DialogDescription>
            Менеджер залогинится в Steam Mobile API и проведёт через нужные коды: Steam Guard,
            телефон и SMS активации.
          </DialogDescription>
        </DialogHeader>

        {phase.name === "intro" && (
          <div className="space-y-3 text-sm">
            <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-amber-300">
              <p className="font-medium">Что нужно знать:</p>
              <ul className="mt-2 list-disc space-y-1 pl-4">
                <li>
                  Steam поставит <strong>15-дневный hold</strong> на трейды и маркет — обойти
                  нельзя.
                </li>
                <li>
                  Если телефон уже привязан, оставь поля телефона пустыми и просто начни
                  привязку.
                </li>
                <li>
                  Если телефона нет, введи номер здесь. Steam может прислать письмо со ссылкой
                  подтверждения, затем SMS для SDA.
                </li>
                <li>
                  После успеха сохрани <strong>revocation code</strong> — он нужен для отвязки SDA.
                </li>
              </ul>
            </div>

            <div className="space-y-2 rounded-md border border-border bg-muted/30 p-3">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Если номера на аккаунте нет
              </p>
              <PhoneInputFields
                countryIso={phoneCountryIso}
                phoneNumber={phoneNumber}
                onCountryChange={setPhoneCountryIso}
                onPhoneChange={setPhoneNumber}
              />
              <p className="text-xs text-muted-foreground">
                Для уже привязанного телефона эти поля не нужны. Если вставишь номер целиком с
                кодом страны, менеджер сам уберёт дубль кода.
              </p>
            </div>

            <Button className="w-full" onClick={() => void start()}>
              Начать привязку
            </Button>
          </div>
        )}

        {phase.name === "starting" && (
          <div className="py-6 text-center text-sm text-muted-foreground">
            Выполняю шаг в Steam… (до 45 сек)
          </div>
        )}

        {phase.name === "steam-guard" && (
          <div className="space-y-4 text-sm">
            <div className="rounded-md border border-primary/40 bg-primary/10 p-3 text-primary">
              Steam требует подтверждение входа. {phase.guardDetail ? `Деталь: ${phase.guardDetail}.` : ""}
            </div>
            <div className="space-y-1">
              <Label>{steamGuardLabel(phase.guardType)}</Label>
              <Input
                value={steamGuardCode}
                onChange={(e) => setSteamGuardCode(e.target.value)}
                placeholder="ABCDE"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter" && steamGuardCode.trim()) void submitSteamGuard();
                }}
              />
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={() => void close()}>
                Отменить
              </Button>
              <Button onClick={() => void submitSteamGuard()} disabled={!steamGuardCode.trim()}>
                Продолжить
              </Button>
            </DialogFooter>
          </div>
        )}

        {phase.name === "phone-number" && (
          <div className="space-y-4 text-sm">
            <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-amber-300">
              Steam не видит подтверждённый телефон на аккаунте. Введи номер, который нужно
              привязать.
            </div>
            <PhoneInputFields
              countryIso={phoneCountryIso}
              phoneNumber={phoneNumber}
              autoFocus
              onCountryChange={setPhoneCountryIso}
              onPhoneChange={setPhoneNumber}
            />
            <DialogFooter>
              <Button variant="ghost" onClick={() => void close()}>
                Отменить
              </Button>
              <Button onClick={() => void submitPhone()} disabled={!phoneNumber.trim()}>
                Привязать номер
              </Button>
            </DialogFooter>
          </div>
        )}

        {phase.name === "phone-email" && (
          <div className="space-y-4 text-sm">
            <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-amber-300">
              Steam отправил письмо для подтверждения добавления телефона. Открой письмо и нажми
              кнопку <strong>ADD PHONE NUMBER</strong> в браузере. После этого вернись сюда и
              нажми проверку.
            </div>
            {phoneEmailInfo && <p className="text-xs text-muted-foreground">{phoneEmailInfo}</p>}
            <Button className="w-full" onClick={() => void checkPhoneEmail()}>
              Я нажал ADD PHONE NUMBER, проверить
            </Button>
            <details className="rounded-md border border-border bg-muted/20 p-3">
              <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
                Запасной способ: вставить ссылку или stoken
              </summary>
              <div className="mt-3 space-y-2">
                <p className="text-xs text-muted-foreground">
                  Обычно это не нужно. Используй только если подтверждение через браузер не
                  сработало.
                </p>
                <div className="space-y-1">
                  <Label>Ссылка из письма Steam / stoken</Label>
                  <Input
                    value={phoneEmailToken}
                    onChange={(e) => setPhoneEmailToken(e.target.value)}
                    placeholder="https://store.steampowered.com/phone/confirm?..."
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && phoneEmailToken.trim()) void submitPhoneEmail();
                    }}
                  />
                </div>
                <Button
                  variant="outline"
                  className="w-full"
                  onClick={() => void submitPhoneEmail()}
                  disabled={!phoneEmailToken.trim()}
                >
                  Подтвердить через ссылку/stoken
                </Button>
              </div>
            </details>
            <DialogFooter>
              <Button variant="ghost" onClick={() => void close()}>
                Отменить
              </Button>
            </DialogFooter>
          </div>
        )}

        {phase.name === "phone-sms" && (
          <div className="space-y-4 text-sm">
            <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 p-3 text-emerald-300">
              Steam просит SMS-код для подтверждения номера телефона.
            </div>
            <div className="space-y-1">
              <Label>SMS-код телефона</Label>
              <Input
                value={phoneSmsCode}
                onChange={(e) => setPhoneSmsCode(e.target.value)}
                placeholder="12345"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter" && phoneSmsCode.trim()) void submitPhoneSms();
                }}
              />
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={() => void close()}>
                Отменить
              </Button>
              <Button onClick={() => void submitPhoneSms()} disabled={!phoneSmsCode.trim()}>
                Подтвердить SMS
              </Button>
            </DialogFooter>
          </div>
        )}

        {phase.name === "code-prompt" && (
          <div className="space-y-4 text-sm">
            <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 p-3 text-emerald-300">
              <p>
                Steam отправил SMS с кодом активации SDA
                {phase.maskedPhone ? ` на номер ${phase.maskedPhone}` : ""}.
              </p>
              <p className="mt-1 text-xs">Введи код сюда, чтобы завершить привязку.</p>
            </div>

            {phase.revocationCode && <RevocationCodeBox code={phase.revocationCode} preview />}

            <div className="space-y-1">
              <Label>SMS-код активации SDA</Label>
              <Input
                value={activationCode}
                onChange={(e) => setActivationCode(e.target.value)}
                placeholder="например: ABC12"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter" && activationCode.trim()) void submitActivation();
                }}
              />
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={() => void close()}>
                Отменить
              </Button>
              <Button onClick={() => void submitActivation()} disabled={!activationCode.trim()}>
                Подтвердить код
              </Button>
            </DialogFooter>
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
              SDA успешно привязан. Steam Guard теперь будет генерироваться из менеджера.
            </div>
            {phase.revocationCode && <RevocationCodeBox code={phase.revocationCode} />}
            <DialogFooter>
              <Button onClick={() => onOpenChange(false)}>Готово</Button>
            </DialogFooter>
          </div>
        )}

        {phase.name === "error" && (
          <div className="space-y-3 text-sm">
            <div
              className={`whitespace-pre-line rounded-md border p-3 ${
                phase.limitedAccount
                  ? "border-amber-500/40 bg-amber-500/10 text-amber-200"
                  : "border-destructive/40 bg-destructive/10 text-destructive"
              }`}
            >
              <ShieldAlert className="mb-1 h-4 w-4" />
              {phase.message}
            </div>
            {phase.revocationCode && <RevocationCodeBox code={phase.revocationCode} />}
            <DialogFooter>
              <Button variant="ghost" onClick={() => void close()}>
                Закрыть
              </Button>
              {phase.limitedAccount ? (
                <Button
                  onClick={() => {
                    void window.open(
                      "https://store.steampowered.com/account/addfunds",
                      "_blank",
                    );
                  }}
                >
                  Открыть Steam Wallet
                </Button>
              ) : (
                <Button
                  onClick={() => {
                    if (phase.sessionId) void api.sda.cancelRegistration(phase.sessionId);
                    setPhase({ name: "intro" });
                  }}
                >
                  Попробовать снова
                </Button>
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
        Понадобится для отвязки SDA в будущем. Без него Valve поставит кулдаун.
      </p>
    </div>
  );
}
