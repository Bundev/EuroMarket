# Интеграционные тесты EuroMarket

Подготовьте отдельную базу `euromarket_test` со схемой из `database/schema.sql`
и отдельного пользователя с правами на данные и DDL этой базы. Тесты проверяют
в том числе повторное применение миграций. Для проверки HTTPS нужен OpenSSL.
При необходимости задайте путь к нему в `TEST_OPENSSL`.

В PowerShell задайте параметры для текущего терминала. В CI передавайте пароль
из хранилища секретов.

```powershell
$env:DB_NAME = 'euromarket_test'
$env:DB_HOST = '127.0.0.1'
$env:DB_PORT = '3306'
$credential = Get-Credential -Message 'Учётная запись тестовой MariaDB'
$env:DB_USER = $credential.UserName
$env:DB_PASSWORD = $credential.GetNetworkCredential().Password
npm test
```

Команда последовательно запускает все `tests/*.integration.js`. Для одного набора
в том же окружении выполните, например, `node tests/favorites.integration.js`.
Оба способа проверяют имя подключённой базы, видимость рабочей базы и права
пользователя до запуска тестов. Production-окружение, глобальные привилегии
и назначенные роли блокируют запуск. После завершения закройте тестовый терминал.
