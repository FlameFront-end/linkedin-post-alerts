# Запуск и восстановление

## Локально

Node.js >=22.13, npm, Docker Compose.

```sh
npm ci
cp .env.example .env
docker compose up -d postgres
node --env-file=.env --import tsx scripts/migrate.ts
npm run build
```

Запустить `npm run start:collector`, `npm run start:processor`, `npm run start:notifier`
в отдельных терминалах. Конфигурация читается при старте и проверяется до работы.
`npm run migrate` пригоден для окружений, где DATABASE_URL уже экспортирован.
Повторный запуск мигратора пропускает применённые миграции.

## Все процессы в Docker

```sh
docker compose up --build -d
docker compose ps
docker compose logs --tail=30 collector processor notifier
```

Compose намеренно фиксирует mock + dry-run и не передаёт токены. Переключение live
нужно делать отдельным осознанным изменением после реализации адаптера.
PostgreSQL доступен только на `127.0.0.1:55432`, health — на 3101/3102/3103.
Пароль базы в Compose — только для локальной разработки.

`GET /health/live` подтверждает процесс. `GET /health/ready` проверяет наличие очереди в БД.
Проверку не следует считать подтверждением актуальности LinkedIn или доступности Telegram.

## Диагностика очереди

```sh
docker compose exec postgres psql -U alerts -d alerts -c "SELECT kind,status,count(*) FROM queue.jobs GROUP BY kind,status ORDER BY kind,status"
```

`dead` требует выяснить причину. В БД хранятся только категории ошибок, без token/URL запроса.
Дальнейшая диагностика провайдера потребует безопасных кодов ошибок, не полного дампа ответа.
Не включать verbose-логирование cookies/Telegram URL.

После устранения причины отдельное выбранное задание можно вернуть:

```sql
UPDATE queue.jobs SET status='pending', attempts=0, available_at=now(),
  lock_token=NULL, locked_until=NULL, last_error=NULL
WHERE id = 123 AND status='dead';
```

Команда выше — пример, заменить ID. Не сбрасывать всю очередь автоматически.
Dry-run помечает уведомления завершёнными: live replay нужно планировать отдельно.

## Остановка

`docker compose down` останавливает процессы и сохраняет volume.
`docker compose down -v` удаляет локальные данные; не использовать для обычного перезапуска.
SIGTERM завершает текущее задание и закрывает соединения; HTTP Telegram ограничен 15 секундами.

## Интеграционная проверка

Только отдельная база с именем, заканчивающимся `_test`:

```sh
docker compose exec postgres createdb -U alerts alerts_test
TEST_DATABASE_URL=postgres://alerts:alerts@localhost:55432/alerts_test npm run test:integration
```

Тест пересоздаёт схемы `queue` и `processing` в тестовой базе.
