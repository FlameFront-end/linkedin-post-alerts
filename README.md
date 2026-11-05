# LinkedIn Post Alerts

Каркас сервиса уведомлений о вакансиях **в постах LinkedIn**.
TypeScript / Node.js 22 / Express 5 / PostgreSQL. Три отдельных процесса;
общие контракты и инфраструктурные библиотеки, без платных сборщиков.

**По умолчанию только тестовые посты и dry-run Telegram. HTTP-адаптер LinkedIn добавлен; проверка на реальном аккаунте ожидает сессию.**

## Быстрый запуск

```sh
npm ci
cp .env.example .env
docker compose up -d postgres
node --env-file=.env --import tsx scripts/migrate.ts
npm run build
```

Далее в трёх терминалах:

```sh
npm run start:collector
npm run start:processor
npm run start:notifier
```

Или весь стек: `docker compose up --build` (миграция выполняется отдельным контейнером).
`npm run demo` — автономный прогон отбора без базы, сети и Telegram.

## Навигация

- `services/collector`: источники постов и периодический сбор.
- `services/processor`: классификация, сохранение результата и постановка уведомления.
- `services/notifier`: доставка и повторы после ошибок Telegram.
- `packages/contracts`: проверяемые входные данные и типы.
- `packages/queue`: долговечная очередь PostgreSQL с арендой задания.
- `packages/runtime`: конфигурация, соединения, остановка, health endpoints.
- `migrations`: версия схемы данных.
- `docs/ARCHITECTURE.md`: границы и гарантии.
- `docs/WORKLOG.md`: шаги и решения.
- `docs/OPEN_QUESTIONS.md`: сомнения и ограничения.
- `docs/RUNBOOK.md`: запуск, диагностика, восстановление.

## Проверки

`npm run typecheck`, `npm test`, `npm run build`, `npm run format:check`.
Для `npm run test:integration` нужен отдельный TEST_DATABASE_URL.
Тесты интеграции очищают только таблицы в этой тестовой базе — не направляйте на рабочую.

## Подключение аккаунтов

Для mock не требуется. Для LinkedIn см. `docs/LINKEDIN_ADAPTER.md`: локальный файл сессии,
список авторов и/или текущий поисковый запрос. Без них реальный режим не запускается.
Cookies, токены и содержимое постов не должны попадать в Git или обычные логи.
