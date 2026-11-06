# Подпись кода через SignPath (без окна SmartScreen)

SignPath Foundation бесплатно подписывает открытые проекты своим сертификатом. После подписи Windows
показывает издателя вместо «Неизвестный издатель», а SmartScreen перестаёт пугать новых игроков,
когда у сертификата накопится репутация.

CI уже готов: `.github/workflows/tauri.yml` подписывает оба установщика (`RxLauncher Setup <версия>.exe`
и NSIS-файл автообновления), как только в репозитории появятся секрет и переменная ниже.
Без них сборка идёт как раньше, без подписи.

## 1. Заявка

1. Откройте https://signpath.org/apply и подайте заявку на проект `ReflexerFTP/RxLauncher`.
2. Требования SignPath Foundation: открытая лицензия (у нас GPL-3.0), публичный репозиторий,
   сборка релизов в CI (GitHub Actions), описание проекта и сайт (https://rxlauncher.xyz).
3. Рассмотрение занимает от нескольких дней до пары недель. Ответ придёт на почту.

## 2. Настройка в SignPath (после одобрения)

1. Проект со slug `RxLauncher`, Trusted Build System — GitHub.com, репозиторий `ReflexerFTP/RxLauncher`.
2. Artifact configuration со slug `installers`:

   ```xml
   <?xml version="1.0" encoding="utf-8"?>
   <artifact-configuration xmlns="http://signpath.io/artifact-configuration/v1">
     <zip-file>
       <pe-file-set>
         <include path="*.exe" min-matches="1" max-matches="2" />
         <for-each>
           <authenticode-sign />
         </for-each>
       </pe-file-set>
     </zip-file>
   </artifact-configuration>
   ```

3. Signing policy со slug `release-signing` (сертификат SignPath Foundation).
4. Создайте API token пользователя-«CI» с правом Submitter для этой политики.

Если slug получились другими, задайте их переменными `SIGNPATH_PROJECT_SLUG`, `SIGNPATH_POLICY_SLUG`,
`SIGNPATH_ARTIFACT_SLUG`.

## 3. GitHub

```
gh secret set SIGNPATH_API_TOKEN -R ReflexerFTP/RxLauncher
gh variable set SIGNPATH_ORGANIZATION_ID -R ReflexerFTP/RxLauncher --body "<id организации из SignPath>"
```

Дальше запуск workflow «Tauri build» с галочкой «Собрать и установщик» соберёт подписанные установщики.
Манифест автообновления считается уже по подписанному файлу.
