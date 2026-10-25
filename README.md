# RxLauncher

Бесплатный Minecraft-лаунчер с открытым исходным кодом. Любые версии игры, готовые сборки в один клик, моды без поиска по сайтам и игра с друзьями по одному коду.

![Главный экран RxLauncher](site/assets/shots/home.webp)

## Ссылки

- [Последний релиз (установщик для Windows)](https://github.com/Maksimrrrsrc/RxLauncher/releases/latest)
- [Сайт лаунчера](https://rxlauncher.ru)
- [Плагин на сервер для поддержки системы скинов лаунчера](https://github.com/MaxRx/RxLauncher-Skins-Plugin)

## Возможности

- **Любые версии Minecraft**: релизы, снапшоты, бета и альфа; Fabric, Forge, NeoForge, Quilt и Forge с OptiFine; свои версии.
- **Каталог Modrinth**: сборки, моды, ресурспаки, шейдеры и датапаки. Мод ставится вместе с зависимостями, сборка — целиком, одной кнопкой.
- **Сборки**: отдельные игры со своими модами, мирами, настройками и памятью. Сборки из каталога обновляются кнопкой.
- **Играть вместе**: код сборки и приглашение на сервер для друга, экспорт в `.mrpack`.
- **Разбор вылетов**: причина вылета простыми словами и кнопки, которые её исправляют.
- **Проверка модов перед запуском**: недостающие зависимости, моды для другой версии игры, дубликаты.
- **Копии миров**: автоматически после каждой игры, восстановление в два клика.
- **Статистика**: время в игре, серверы, миры, версии, K/D и календарь игры. Хранится только на вашем ПК.
- **Скины, серверы, скриншоты, Discord Rich Presence** и широкие настройки оформления.

Нужная Java, загрузчик и файлы сборки скачиваются автоматически, параллельно и с проверкой хешей.

## Сборка из исходников

```bash
git clone https://github.com/Maksimrrrsrc/RxLauncher.git
cd RxLauncher
npm install
npm start
```

Режим разработчика: `npm run dev`.

Тесты: `node tests/<имя>.test.js` для модулей и `npx electron tests/electronUiSmoke.js` для проверки интерфейса.

## Технологии

- [Electron](https://www.electronjs.org/), EJS, jQuery
- [minecraft-launcher-core](https://github.com/Pierce01/MinecraftLauncher-core)
- [tomate-loaders](https://github.com/doublekekse/tomate-loaders)
- [Modrinth API](https://docs.modrinth.com/)

## Сайт

Исходники сайта лежат в папке [`site`](site): чистые HTML, CSS и JS без сборки. Скриншоты для него снимает `tests/siteShots.js`.

## Лицензия

Проект распространяется под лицензией GPL-3.0. Подробности — в файле [LICENSE](LICENSE).

RxLauncher не является официальным продуктом Minecraft и не связан с Mojang или Microsoft.
