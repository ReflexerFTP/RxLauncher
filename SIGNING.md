# Подписанная сборка RxLauncher для Windows

Релизная сборка намеренно блокируется без доверенного RSA-сертификата подписи кода. Самоподписанный сертификат не подходит: SmartScreen и Smart App Control не считают его доверенным.

## Необходимые данные

- PFX/P12-сертификат Code Signing от доверенного центра сертификации;
- пароль сертификата;
- полный `Subject DN` сертификата (например, `CN=..., O=..., L=..., C=...`);
- действующая цепочка доверия Windows и доступ к серверу метки времени.

Вместо экспортируемого PFX можно использовать сертификат на аппаратном токене/в хранилище Windows. Для него задаётся `RXLAUNCHER_CERTIFICATE_SHA1` — 40-значный thumbprint сертификата.

Сертификат и пароль нельзя добавлять в репозиторий. Они передаются только через переменные окружения:

```powershell
$env:WIN_CSC_LINK = 'C:\secure\RxLauncher-Code-Signing.pfx'
$securePassword = Read-Host 'Пароль сертификата' -AsSecureString
$env:WIN_CSC_KEY_PASSWORD = [System.Net.NetworkCredential]::new('', $securePassword).Password
$env:RXLAUNCHER_PUBLISHER_NAME = 'CN=ТОЧНЫЙ SUBJECT, O=ОРГАНИЗАЦИЯ, C=СТРАНА'
npm run build-win
Remove-Item Env:WIN_CSC_KEY_PASSWORD
```

Вариант с аппаратным токеном или хранилищем Windows:

```powershell
$env:RXLAUNCHER_CERTIFICATE_SHA1 = '40-ЗНАЧНЫЙ-THUMBPRINT-БЕЗ-ПРОБЕЛОВ'
$env:RXLAUNCHER_PUBLISHER_NAME = 'CN=ТОЧНЫЙ SUBJECT, O=ОРГАНИЗАЦИЯ, C=СТРАНА'
npm run build-win
```

`npm run build-win` выполняет три обязательных этапа:

1. electron-builder подписывает приложение, вспомогательный elevating-процесс и NSIS-установщик;
2. полный Subject DN записывается и в `app-update.yml`, и внутрь защищённого `app.asar`; при запуске значения обязаны совпасть, поэтому подмена внешнего файла конфигурации не меняет доверенного издателя;
3. `scripts/verify-windows-signatures.ps1` проверяет доверие, единого издателя и метку времени у всех релизных файлов.

При отсутствии сертификата, неверном пароле, недоверенной подписи или отсутствии метки времени сборка завершается ошибкой и неподписанный установщик не считается релизом.
