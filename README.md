# d2smurf

Менеджер Steam-аккаунтов для Dota 2. Десктоп-приложение под Windows: Electron + React + TypeScript + Tailwind + SQLCipher.

## Что умеет (MVP в этом PR)

- Зашифрованное локальное хранилище: AES-256-GCM мастер-пароль + SQLCipher.
- Импорт аккаунтов:
  - drag-n-drop / вставка `.txt` в форматах `login:password`, `login:password:email:emailPass`;
  - привязка `.maFile` к существующему аккаунту (вручную или массово из папки SDA).
- Карточка аккаунта: аватар, ник, SteamID64, Dota Friend ID, MMR, значок ранга, Behavior (1–12000), Communication (1–12000), LP-статус, email/email-пароль, прокси, теги, заметки, дата последнего чека.
- Перечек: подтягивает аватар/ник/MMR/ранг через Steam Web API + OpenDota (без логина в Steam).
- Drag-n-drop сортировка карточек, фильтр по тегам, поиск, сортировка по MMR/поведению/общению/логину/дате чека.
- 2FA-код: окно с TOTP-кодом и обратным таймером — если у аккаунта привязан `.maFile`.
- Лаунчер: «Старт Steam» (`steam.exe -login user pass`) и «Старт + Overplus» — менеджер помечает аккаунт как `MostRecent` в `loginusers.vdf`, гасит Steam, запускает Overplus, который сам поднимет Steam и Dota.
- Авточек по расписанию (cron-задача в фоне).
- Бэкап зашифрованной БД.

## Что НЕ в этом PR (следующие итерации)

- Полноценный логин в Steam Game Coordinator и получение **реальных** behavior/communication score, LP-флагов из GC.
- SDA-флоу: привязка телефона + `enableTwoFactor` — UI вшит, главный процесс возвращает заглушку до интеграции `steam-user`.
- Steam Guard auto-confirm tray (нужен `koffi` / Windows UI Automation — добавим позже).

Этот PR — фундамент: модели, импорт, UI, шифрование, лаунчер. Следующие итерации подключают `steam-user` / `steamcommunity` / `dota2` (DoctorMcKay).

## Установка

```bash
npm install
npm run dev         # запустит Electron в dev-режиме
npm run build:win   # соберёт .exe (NSIS installer)
npm run lint
npm run typecheck
```

Зависимости `better-sqlite3-multiple-ciphers` собираются нативно через `electron-builder install-app-deps` после `npm install`.

## Структура

```
electron/
  main/         # main process: db, vault, importers, steam, ipc
  preload/      # contextBridge API
  shared/       # типы общие для main и renderer
src/            # React UI: pages, components, store (zustand)
```

## Безопасность

- Все секреты (пароли Steam, пароли email, `.maFile` секреты) хранятся **только** локально, в SQLCipher-зашифрованной БД (`%APPDATA%/d2smurf/vault.db`).
- Ключ выводится из мастер-пароля через `scrypt(N=2^15, r=8, p=1)`. Без мастер-пароля файл нечитаем.
- Приложение по умолчанию автоматически блокирует хранилище при закрытии окна.
- В `.gitignore` исключены все локальные базы, сборки и `.maFile`.

## Лицензия

UNLICENSED — приватный проект.
