class RxPatchNotes {
    static ITEMS = [
        {
            id: "3.11.0-security-audit",
            version: "3.11.0",
            date: "2026-10-29T18:00:00+03:00",
            image: "assets/version-heroes/1.20.png",
            tag: {ru: "БЕЗОПАСНОСТЬ", en: "SECURITY"},
            title: {ru: "Исправления по аудиту безопасности", en: "Security audit fixes"},
            summary: {
                ru: "Токены Ely.by больше не попадают в журнал, загрузки сборок не ходят в локальную сеть и не превышают заявленный размер.",
                en: "Ely.by tokens no longer reach the log, modpack downloads never reach the local network or exceed their declared size."
            },
            changes: {
                ru: [
                    "Токены сессии Ely.by не попадают в журнал и архив отладки ни под каким именем аргумента.",
                    "Файлы сборок не скачиваются с адресов локальной сети, даже если на неё указывает обычное доменное имя.",
                    "Размер каждого скачанного файла сверяется с заявленным; у загрузки есть общий лимит и проверка свободного места.",
                    "Импорт из других лаунчеров сравнивает большие файлы по содержимому — изменённые моды больше не пропускаются.",
                    "Импорт CurseForge: папка overrides только из архива, точная версия Forge/NeoForge/Fabric сохраняется.",
                    "Старое окно сборок удаляет сборку в корзину и только по проверенному имени папки.",
                    "Сервер аккаунтов: одновременные попытки входа больше не обходят лимит."
                ],
                en: [
                    "Ely.by session tokens never reach the log or the debug archive under any argument name.",
                    "Modpack files are never downloaded from local network addresses, even through a normal domain name.",
                    "Every downloaded file is checked against its declared size; downloads have a total limit and a free space check.",
                    "Import from other launchers compares large files by content, so changed mods are no longer skipped.",
                    "CurseForge import: the overrides folder only from the archive, the exact Forge/NeoForge/Fabric version is kept.",
                    "The old modpack window moves a modpack to the Recycle Bin and only by its verified folder name.",
                    "Account server: simultaneous login attempts no longer bypass the limit."
                ]
            }
        },
        {
            id: "3.10.0-announcements-recommended",
            version: "3.10.0",
            date: "2026-10-29T12:00:00+03:00",
            image: "assets/version-heroes/1.21.png",
            tag: {ru: "НОВОСТИ", en: "NEWS"},
            title: {ru: "Объявления и рекомендации", en: "Announcements and picks"},
            summary: {
                ru: "Новости RxLauncher теперь появляются прямо на главной, а в «Серверах» и каталоге — серверы и сборки, которые мы рекомендуем.",
                en: "RxLauncher news now shows right on the home screen, and Servers and the catalog highlight servers and modpacks we recommend."
            },
            changes: {
                ru: [
                    "Объявления на главной над списком патчей: обновления, ивенты, важное. Новое приходит уведомлением, ненужное можно скрыть.",
                    "«Серверы»: рекомендуемые серверы первыми, со значком «Рекомендуем» и правильной версией для входа.",
                    "Каталог сборок: блок «Рекомендуем» в начале списка.",
                    "Админка: всё об игроке — время в игре, последняя игра, активность за 30 дней, друзья, устройства и «Выйти на всех устройствах».",
                    "Админка: статистика — аккаунты, онлайн, графики регистраций и активности, популярные версии, загрузчики и серверы.",
                    "На сайте в админке — объявления и рекомендации: публикация, срок показа, порядок."
                ],
                en: [
                    "Announcements on the home screen above the patch list: updates, events, important notes. New ones arrive as a notification and can be hidden.",
                    "Servers: recommended servers come first with a Recommended badge and the right version to join.",
                    "Modpack catalog: a Recommended block at the top.",
                    "Admin panel: player details — play time, last game, 30-day activity, friends, devices and Log out everywhere.",
                    "Admin panel: statistics — accounts, online, sign-up and activity charts, popular versions, loaders and servers.",
                    "The website admin panel manages announcements and picks: publishing, expiry date, order."
                ]
            }
        },
        {
            id: "3.9.0-friends-tab-menu-login",
            version: "3.9.0",
            date: "2026-10-29T01:00:00+03:00",
            image: "assets/version-heroes/1.21.png",
            tag: {ru: "ИНТЕРФЕЙС", en: "INTERFACE"},
            title: {ru: "Вкладка «Друзья», новое меню и вход", en: "Friends tab, new menu and login"},
            summary: {
                ru: "Друзья переехали в свою вкладку, боковое меню разворачивается с подписями, окно входа стало удобнее — а вход через Discord заработал.",
                en: "Friends moved to their own tab, the side menu expands with labels, the login window is easier to use — and Discord login now works."
            },
            changes: {
                ru: [
                    "Отдельная вкладка «Друзья»: «В игре», «В лаунчере», «Не в сети», заявки, профиль и настройки приватности справа.",
                    "Кнопки «Зайти» и «Сборка» с подписями, значок с числом заявок или друзей в сети прямо на вкладке меню.",
                    "Боковое меню разворачивается кнопкой сверху: значки с подписями и группами «Вместе» и «Инструменты». Панель «Ещё» убрана.",
                    "Новое окно входа: вход через Discord сверху, поля с подписями.",
                    "Вход и регистрация через Discord включены.",
                    "Защита установленного лаунчера: без DevTools и отладки, проверка целостности файлов."
                ],
                en: [
                    "A separate Friends tab: Playing, In the launcher, Offline, requests, and your profile and privacy settings on the right.",
                    "Labelled Join and Setup buttons, and a badge with requests or online friends right on the menu tab.",
                    "The side menu expands with the button at the top: icons with labels and Together/Tools groups. The More panel is gone.",
                    "A new login window: Discord login at the top, labelled fields.",
                    "Discord login and sign-up are enabled.",
                    "The installed launcher is protected: no DevTools or debugging, file integrity check."
                ]
            }
        },
        {
            id: "3.8.0-friends-copy-discord",
            version: "3.8.0",
            date: "2026-10-28T23:00:00+03:00",
            image: "assets/version-heroes/1.21.png",
            tag: {ru: "ДРУЗЬЯ", en: "FRIENDS"},
            title: {ru: "Сборки друзей, Discord и новое меню", en: "Friends' setups, Discord and a new menu"},
            summary: {
                ru: "Копируйте сборку друга в один клик, смотрите, во что он играл последний раз, входите через Discord — а боковое меню стало аккуратнее.",
                en: "Copy a friend's setup in one click, see what they played last, log in with Discord — and the side menu is tidier."
            },
            changes: {
                ru: [
                    "«Кто может копировать мою сборку»: никто, все друзья или выбранные — в лаунчере и на сайте. Друг ставит ваши моды, ресурспаки и шейдеры одной кнопкой.",
                    "Друг не в сети — видно, когда он был и во что играл последний раз: версия, сборка и сервер.",
                    "Статус друзей стал нагляднее: «Играет» с пульсом, значки загрузчика, сборки и сервера.",
                    "Значки групп с иконками: Админ, Тестер, Игрок+.",
                    "Вход и регистрация через Discord — на сайте и в лаунчере.",
                    "Боковое меню: не больше четырёх вкладок в ряд, остальные — в аккуратной панели «Ещё». Настройки переехали вниз."
                ],
                en: [
                    "\"Who can copy my setup\": nobody, all friends or selected friends — in the launcher and on the website. A friend installs your mods, resource packs and shaders in one click.",
                    "When a friend is offline you see when they were online and what they played last: version, setup and server.",
                    "Friend status is clearer: a pulsing \"Playing\", loader, setup and server chips.",
                    "Group badges with icons: Admin, Tester, Player+.",
                    "Log in and sign up with Discord — on the website and in the launcher.",
                    "Side menu: at most four tabs in a row, the rest in a neat \"More\" panel. Settings moved to the bottom."
                ]
            }
        },
        {
            id: "3.7.0-friends-accounts",
            version: "3.7.0",
            date: "2026-10-28T20:00:00+03:00",
            image: "assets/version-heroes/1.20.png",
            tag: {ru: "ДРУЗЬЯ", en: "FRIENDS"},
            title: {ru: "Друзья и аккаунт RxLauncher", en: "Friends and RxLauncher account"},
            summary: {
                ru: "Зарегистрируйтесь на rxlauncher.xyz, войдите в лаунчере, добавляйте друзей и смотрите, кто где играет — и заходите к ним на сервер в один клик.",
                en: "Sign up on rxlauncher.xyz, log in to the launcher, add friends, see who plays where and join their server in one click."
            },
            changes: {
                ru: [
                    "Аккаунт RxLauncher: регистрация на сайте rxlauncher.xyz/account, в лаунчере — новое окно входа («Играть вместе» → «Друзья»).",
                    "Ник можно сменить в любой момент (в лаунчере или на сайте): друзья сразу видят новый, игровой профиль переименовывается вместе с ним.",
                    "Группы игроков: Админ, Тестер, Игрок+ и Игрок. Админка в лаунчере и на сайте: группы, бан, смена ника, сброс пароля.",
                    "Друзья по нику: заявки, принятие, удаление. Видно, кто в лаунчере, кто играет, на какой версии и сервере, и сколько времени.",
                    "«Зайти к другу» запускает игру сразу на его сервер.",
                    "Невидимка и «Показывать друзьям мой сервер». В режиме паранойи друзья выключены.",
                    "Пароль хранится на сервере только как стойкий хеш, сессия на ПК зашифрована средствами Windows."
                ],
                en: [
                    "RxLauncher account: sign up on rxlauncher.xyz/account, and log in through the new window in the launcher (\"Play together\" → \"Friends\").",
                    "Change your nickname any time (in the launcher or on the website): friends see the new one right away and your game profile is renamed with it.",
                    "Player groups: Admin, Tester, Player+ and Player. Admin panel in the launcher and on the website: groups, bans, nickname changes, password resets.",
                    "Friends by nickname: requests, accepting, removing. See who is in the launcher, who is playing, on which version and server, and for how long.",
                    "\"Join friend\" starts the game straight on their server.",
                    "Invisible mode and \"Show my server to friends\". Friends are off in paranoid mode.",
                    "The server stores only a strong password hash, and the session on your PC is encrypted by Windows."
                ]
            }
        },
        {
            id: "3.6.0-command-history-anti-theft",
            version: "3.6.0",
            date: "2026-10-28T00:00:00+03:00",
            image: "assets/version-heroes/1.21.png",
            tag: {ru: "ЗАЩИТА", en: "PROTECTION"},
            title: {ru: "Анти-кража истории команд", en: "Command history anti-theft"},
            summary: {
                ru: "Пароли от серверов больше не лежат в command_history.txt: файл прячется, пока вы не играете, а команды входа в него не попадают.",
                en: "Server passwords no longer sit in command_history.txt: the file is hidden while you are not playing, and login commands never stay in it."
            },
            changes: {
                ru: [
                    "Настройки → Игровой процесс → «Анти-кража истории команд» (включена сразу).",
                    "После выхода из игры command_history.txt уезжает в зашифрованное хранилище лаунчера — каждый раз под новым случайным именем в новой случайной папке.",
                    "Перед запуском история возвращается на место: стрелка ↑ в чате работает как обычно.",
                    "«Не сохранять пароли в истории»: команды /l, /login, /reg, /register, /changepassword убираются из файла сразу, даже пока игра запущена.",
                    "Выключили функцию — история возвращается в папки игры."
                ],
                en: [
                    "Settings → Gameplay → \"Command history anti-theft\" (on by default).",
                    "After you quit, command_history.txt moves to the launcher's encrypted storage under a new random name in a new random folder each time.",
                    "It comes back before launch, so the ↑ key in chat works as usual.",
                    "\"Do not keep passwords in history\": /l, /login, /reg, /register and /changepassword are removed from the file right away, even while the game is running.",
                    "Turn the feature off and the history returns to the game folders."
                ]
            }
        },
        {
            id: "3.5.0-import-fast-downloads",
            version: "3.5.0",
            date: "2026-10-27T12:00:00+03:00",
            image: "assets/version-heroes/1.21.png",
            tag: {ru: "ИМПОРТ", en: "IMPORT"},
            title: {ru: "Импорт из других лаунчеров", en: "Import from other launchers"},
            summary: {
                ru: "Переезжайте из Legacy Launcher и TLauncher за минуту, а версии игры теперь скачиваются в несколько раз быстрее.",
                en: "Move over from Legacy Launcher and TLauncher in a minute, and game versions now download several times faster."
            },
            changes: {
                ru: [
                    "Настройки → Импорт: лаунчер сам находит Legacy Launcher, TLauncher и папку .minecraft, а любую другую папку можно выбрать вручную.",
                    "Галочками выбирается, что перенести: миры, моды, конфиги, настройки игры, ресурспаки, шейдеры, скриншоты, серверы, ники и уже скачанные файлы игры.",
                    "Резервная копия перед импортом: если что-то пойдёт не так, импорт отменяется тоже по галочкам — добавленное удаляется, заменённые файлы возвращаются.",
                    "Свои миры никогда не перезаписываются: мир с таким же именем переносится как «(импорт)».",
                    "Файлы игры качаются в 16 потоков вместо одного: новые версии загружаются в несколько раз быстрее.",
                    "Если серверы Mojang не отвечают, загрузка сама переключается на зеркало. Источник можно выбрать в Настройки → Параметры запуска."
                ],
                en: [
                    "Settings → Import: the launcher finds Legacy Launcher, TLauncher and the .minecraft folder by itself, and any other folder can be chosen manually.",
                    "Pick what to bring over with checkboxes: worlds, mods, configs, game settings, resource packs, shaders, screenshots, servers, nicknames and already downloaded game files.",
                    "A backup before importing: if something goes wrong, the import can be undone, also with checkboxes. Added files are removed and replaced ones come back.",
                    "Your own worlds are never overwritten: a world with the same name is imported as \"(import)\".",
                    "Game files download over 16 connections instead of one, so new versions install several times faster.",
                    "If Mojang servers do not respond, downloads switch to a mirror automatically. The source can be chosen in Settings → Startup."
                ]
            }
        },
        {
            id: "3.4.0-rpc-avatar",
            version: "3.4.0",
            date: "2026-10-26T19:00:00+03:00",
            image: "assets/version-heroes/1.21.png",
            tag: {ru: "DISCORD", en: "DISCORD"},
            title: {ru: "Новая аватарка в Discord", en: "A new Discord avatar"},
            summary: {
                ru: "В статусе Discord теперь новая 3D-анимация логотипа: стеклянная плитка, красное свечение и скользящие блики.",
                en: "Your Discord status now shows a new animated 3D logo: a glass tile, a red glow and gliding highlights."
            },
            changes: {
                ru: [
                    "Новая анимированная аватарка RxLauncher в Discord: объёмный логотип, читаемый даже в маленьком размере.",
                    "Картинка хранится на сайте rxlauncher.xyz, поэтому её можно обновлять без новой версии лаунчера."
                ],
                en: [
                    "A new animated RxLauncher avatar in Discord: a 3D logo that stays readable even at small sizes.",
                    "The image is hosted on rxlauncher.xyz, so it can be refreshed without a new launcher version."
                ]
            }
        },
        {
            id: "3.3.0-hardening",
            version: "3.3.0",
            date: "2026-10-26T10:00:00+03:00",
            image: "assets/version-heroes/1.21.png",
            tag: {ru: "БЕЗОПАСНОСТЬ", en: "SECURITY"},
            title: {ru: "Безопасность и надёжность", en: "Security and reliability"},
            summary: {
                ru: "Лаунчер стал защищённее: изолированный интерфейс, зашифрованные токены Ely.by и проверка архивов и модпаков перед установкой.",
                en: "The launcher is more secure: an isolated interface, encrypted Ely.by tokens and checks for archives and modpacks before installing."
            },
            changes: {
                ru: [
                    "Интерфейс лаунчера работает в изолированном окружении без прямого доступа к системе.",
                    "Токены аккаунтов Ely.by шифруются средствами Windows.",
                    "ZIP-архивы и модпаки Modrinth проверяются перед распаковкой: опасные пути и слишком большие архивы отклоняются.",
                    "Внешние ссылки и папки открываются только после проверки.",
                    "Техническая статистика отправляется только по желанию: переключатель в Настройки → Игра, по умолчанию выключен.",
                    "Окно лаунчера можно уменьшить до 1024×680.",
                    "Обновлены зависимости, добавлены новые автотесты."
                ],
                en: [
                    "The launcher interface runs in an isolated environment without direct system access.",
                    "Ely.by account tokens are encrypted with Windows' built-in protection.",
                    "ZIP archives and Modrinth modpacks are checked before extraction: unsafe paths and oversized archives are rejected.",
                    "External links and folders open only after validation.",
                    "Technical statistics are opt-in: a toggle in Settings → Game, off by default.",
                    "The launcher window can be shrunk down to 1024×680.",
                    "Dependencies updated, new automated tests added."
                ]
            }
        },
        {
            id: "3.2.0-community",
            version: "3.2.0",
            date: "2026-10-26T01:00:00+03:00",
            image: "assets/version-heroes/1.21.png",
            tag: {ru: "СООБЩЕСТВО", en: "COMMUNITY"},
            title: {ru: "Новые Discord, Telegram и сайт", en: "New Discord, Telegram and website"},
            summary: {
                ru: "У RxLauncher новый Discord-сервер, Telegram-канал и сайт rxlauncher.xyz. Все ссылки собраны в разделе «О лаунчере».",
                en: "RxLauncher has a new Discord server, Telegram channel and the rxlauncher.xyz website. All links are in the About section."
            },
            changes: {
                ru: [
                    "Настройки → «О лаунчере»: новый блок «Сообщество» с Discord, Telegram, GitHub и сайтом.",
                    "Новый Discord: discord.gg/bpRwXsXeuj, новый Telegram: t.me/rxlauncher.",
                    "Исходный код лаунчера теперь на GitHub: ReflexerFTP/RxLauncher.",
                    "Сайт лаунчера: rxlauncher.xyz.",
                    "В статусе Discord две кнопки — Discord и Telegram RxLaunch.",
                    "Ссылки на главном экране RxClient в игре тоже обновлены."
                ],
                en: [
                    "Settings → About: a new Community block with Discord, Telegram, GitHub and the website.",
                    "New Discord: discord.gg/bpRwXsXeuj, new Telegram: t.me/rxlauncher.",
                    "The launcher source code now lives on GitHub: ReflexerFTP/RxLauncher.",
                    "Launcher website: rxlauncher.xyz.",
                    "Discord status shows two buttons — RxLaunch Discord and Telegram.",
                    "Links on the in-game RxClient title screen are updated too."
                ]
            }
        },
        {
            id: "3.1.0-pale-garden",
            version: "3.1.0",
            date: "2026-10-26T00:45:00+03:00",
            image: "assets/version-heroes/1.21.png",
            tag: {ru: "ДИЗАЙН", en: "DESIGN"},
            title: {ru: "Скрипун — новый фон по умолчанию", en: "The Creaking is the new default wallpaper"},
            summary: {
                ru: "Лаунчер встречает новых игроков тёмным Бледным садом — тем же фоном, что на сайте RxLauncher.",
                en: "The launcher greets new players with the dark Pale Garden — the same background as on the RxLauncher website."
            },
            changes: {
                ru: [
                    "Обои по умолчанию — Скрипун в Бледном саду.",
                    "Если вы уже выбрали обои, они не меняются.",
                    "Если свои обои удалили с диска, лаунчер вернёт обои по умолчанию вместо пустого фона."
                ],
                en: [
                    "The default wallpaper is now the Creaking in the Pale Garden.",
                    "Wallpaper you already picked stays as it is.",
                    "If your custom wallpaper was deleted from disk, the launcher falls back to the default instead of an empty background."
                ]
            }
        },
        {
            id: "3.0.0-catalog-together",
            version: "3.0.0",
            date: "2026-10-26T00:30:00+03:00",
            image: "assets/version-heroes/1.21.png",
            tag: {ru: "3.0", en: "3.0"},
            title: {ru: "Каталог, игра с друзьями и новая статистика", en: "Catalog, playing together and new statistics"},
            summary: {
                ru: "Готовые сборки ставятся в один клик, сборкой можно поделиться с другом кодом, миры сохраняются сами, а статистика стала понятнее.",
                en: "Modpacks install in one click, instances can be shared with a friend by code, worlds back up by themselves, and statistics are clearer."
            },
            changes: {
                ru: [
                    "Раздел «Каталог»: сборки, моды, ресурспаки, шейдеры и датапаки с Modrinth. Подробности проекта, скриншоты и выбор версии.",
                    "Сборка ставится одной кнопкой: лаунчер создаёт её, скачивает моды и выбирает для игры. Обновления сборок — кнопкой на карточке.",
                    "Раздел «Играть вместе»: код сборки и приглашение на сервер для друга, экспорт в .mrpack.",
                    "Копии миров сохраняются после игры, восстановить мир можно во вкладке «Миры и копии».",
                    "Перед запуском лаунчер проверяет моды и предупреждает о недостающих зависимостях и модах не для той версии.",
                    "В окне вылета появилась кнопка «Установить» для недостающего мода.",
                    "Новая статистика: график со шкалой часов, календарь игры, рейтинги серверов, миров, версий и ников.",
                    "Файлы сборок качаются параллельно и с проверкой хешей; запуск больше не зависает, если файл не скачался.",
                    "Лаунчер переведён на Electron 44, устаревшая библиотека request убрана."
                ],
                en: [
                    "Catalog: modpacks, mods, resource packs, shaders and data packs from Modrinth, with project details, screenshots and version choice.",
                    "A modpack installs with one button: the launcher creates it, downloads the mods and selects it. Modpack updates are one button on the card.",
                    "Play together: share an instance code or a server invite with a friend, export to .mrpack.",
                    "Worlds are backed up after playing; restore them on the Worlds & backups tab.",
                    "Before launch, the launcher checks mods and warns about missing dependencies and mods for another version.",
                    "The crash window got an Install button for a missing mod.",
                    "New statistics: a chart with an hour scale, a play calendar, rankings of servers, worlds, versions and nicknames.",
                    "Instance files download in parallel with hash checks; launching no longer hangs when a file fails to download.",
                    "The launcher moved to Electron 44, the outdated request library is gone."
                ]
            }
        },
        {
            id: "2.12.0-catalog-scroll",
            version: "2.12.0",
            date: "2026-10-26T21:00:00+03:00",
            image: "assets/version-heroes/1.21.png",
            tag: {ru: "ФИКСЫ", en: "FIXES"},
            title: {ru: "Каталог Modrinth листается", en: "The Modrinth catalog scrolls"},
            summary: {
                ru: "Каталог модов теперь прокручивается колёсиком, а новые моды подгружаются сами — кнопка «Показать ещё» больше не нужна.",
                en: "The mod catalog now scrolls with the mouse wheel and loads more mods by itself — no more “Show more” button."
            },
            changes: {
                ru: [
                    "Исправлено: список каталога не прокручивался, и новые моды добавлялись в невидимую часть.",
                    "Бесконечная прокрутка: следующая порция модов загружается заранее, пока вы листаете.",
                    "Если Modrinth недоступен, догрузка не повторяет запросы бесконечно."
                ],
                en: [
                    "Fixed: the catalog list did not scroll and new mods were added out of sight.",
                    "Infinite scrolling: the next batch of mods loads ahead while you scroll.",
                    "When Modrinth is unavailable, loading more does not retry endlessly."
                ]
            }
        },
        {
            id: "2.11.0-uninstaller-tabs",
            version: "2.11.0",
            date: "2026-10-26T18:00:00+03:00",
            image: "assets/version-heroes/1.21.png",
            tag: {ru: "НОВОЕ", en: "NEW"},
            title: {ru: "Вкладки на выбор и красивое удаление", en: "Pick your tabs and a better uninstaller"},
            summary: {
                ru: "В боковом меню теперь только нужные вкладки, а удаление лаунчера выглядит так же, как установка.",
                en: "The sidebar shows only the tabs you need, and removing the launcher looks just like installing it."
            },
            changes: {
                ru: [
                    "В настройках «Оформление» можно выбрать вкладки бокового меню. По умолчанию включены Главная, Настройки, Статистика и Консоль.",
                    "Вкладки можно выбрать прямо в установщике — кнопка «Настроить» на первом экране.",
                    "Новый установщик стал основным: «RxLauncher Setup».",
                    "Удаление через «Приложения» Windows открывает тёмное окно в том же стиле: с выбором, удалять ли настройки, и прогрессом.",
                    "Миры, моды и сборки в папке игры при удалении никогда не трогаются."
                ],
                en: [
                    "Settings → Appearance lets you choose sidebar tabs. Home, Settings, Statistics and Console are on by default.",
                    "Tabs can be chosen right in the installer with the “Customize” button.",
                    "The new installer is now the main one: “RxLauncher Setup”.",
                    "Uninstalling from Windows Apps opens a dark window in the same style, with an option to delete settings and progress.",
                    "Worlds, mods and instances in the game folder are never touched on uninstall."
                ]
            }
        },
        {
            id: "2.10.0-installer",
            version: "2.10.0",
            date: "2026-10-26T12:00:00+03:00",
            image: "assets/version-heroes/1.21.png",
            tag: {ru: "ДИЗАЙН", en: "DESIGN"},
            title: {ru: "Новый установщик", en: "A new installer"},
            summary: {
                ru: "Установщик полностью переделан: чёрное минималистичное окно со своим артом, понятным прогрессом и без лишних шагов.",
                en: "The installer was rebuilt from scratch: a black minimal window with its own artwork, clear progress and no extra steps."
            },
            changes: {
                ru: [
                    "Своё окно установки: чёрный дизайн, новый арт с парящим островом и светящимся монолитом.",
                    "Один экран вместо мастера: папка, ярлык на рабочем столе и кнопка «Установить».",
                    "Установщик сам находит прошлую установку и обновляет её на месте.",
                    "Плавный прогресс установки, предупреждение, если лаунчер запущен, и кнопка «Запустить» в конце.",
                    "Окна удаления тоже стали тёмными, ссылка на сайт убрана."
                ],
                en: [
                    "Custom setup window: black design and new artwork with a floating island and a glowing monolith.",
                    "One screen instead of a wizard: folder, desktop shortcut and an Install button.",
                    "Setup finds your previous installation and updates it in place.",
                    "Smooth progress, a warning when the launcher is running and a Launch button at the end.",
                    "Uninstall windows are dark too, and the website link is gone."
                ]
            }
        },
        {
            id: "2.9.0-instances-modrinth",
            version: "2.9.0",
            date: "2026-10-25T21:00:00+03:00",
            image: "assets/version-heroes/1.21.png",
            tag: {ru: "БОЛЬШОЕ ОБНОВЛЕНИЕ", en: "MAJOR UPDATE"},
            title: {ru: "Сборки, каталог Modrinth и скриншоты", en: "Instances, Modrinth catalog and screenshots"},
            summary: {
                ru: "Отдельные сборки со своими модами и памятью, каталог модов Modrinth с установкой в один клик, галерея скриншотов и отмена запуска.",
                en: "Separate instances with their own mods and memory, a Modrinth mod catalog with one-click installs, a screenshot gallery and launch cancelling."
            },
            changes: {
                ru: [
                    "Новый раздел «Сборки»: у каждой свои моды, миры, ресурспаки, память и аргументы Java. Можно создать, дублировать, удалить в корзину и импортировать .mrpack.",
                    "В модах появился каталог Modrinth: поиск под вашу версию и загрузчик, категории, установка в один клик вместе с зависимостями.",
                    "Кнопка «Проверить обновления» обновляет моды с Modrinth, а старые версии сохраняет в rx-mod-backups.",
                    "Галерея скриншотов из всех папок и сборок: просмотр, листание стрелками, копирование, удаление в корзину.",
                    "При запуске видны скорость загрузки и оставшееся время, а запуск можно отменить.",
                    "Память можно подбирать автоматически — по числу модов и ОЗУ компьютера.",
                    "Все выпадающие списки заменены на новые, а окно выбора версий закрывается крестиком и клавишей Esc.",
                    "ForgeOptiFine теперь правильно помечается как установленный."
                ],
                en: [
                    "New “Instances” section: each has its own mods, worlds, resource packs, memory and Java arguments. Create, duplicate, move to the Recycle Bin and import .mrpack.",
                    "The mods page now has a Modrinth catalog: search for your version and loader, categories, one-click install with dependencies.",
                    "“Check updates” updates Modrinth mods and keeps old versions in rx-mod-backups.",
                    "Screenshot gallery from every folder and instance: viewer, arrow navigation, copy, move to the Recycle Bin.",
                    "Launching shows download speed and time left, and can be cancelled.",
                    "Memory can be chosen automatically from mod count and computer RAM.",
                    "Every dropdown was replaced with a new one, and the version picker closes with a cross or Esc.",
                    "ForgeOptiFine is now correctly marked as installed."
                ]
            }
        },
        {
            id: "2.8.0-versions-offline-custom",
            version: "2.8.0",
            date: "2026-10-25T18:00:00+03:00",
            image: "assets/version-heroes/1.21.png",
            tag: {ru: "НОВОЕ", en: "NEW"},
            title: {ru: "Новый выбор версий и свои версии", en: "New version picker and custom versions"},
            summary: {
                ru: "Окно выбора версий переделано: вкладки загрузчиков, сортировка и свои версии. Установленные версии теперь запускаются и без интернета.",
                en: "The version picker was rebuilt with loader tabs, sorting and custom versions. Installed versions now launch without internet."
            },
            changes: {
                ru: [
                    "Новое окно выбора версий: поиск, вкладки Vanilla / Fabric / Forge / NeoForge / Quilt / OptiFine / Свои с количеством версий.",
                    "Сортировка: сначала новые, сначала старые, по названию, сначала установленные или избранные.",
                    "Свою версию можно добавить кнопкой «Своя версия» или перетащить в окно папку версии, .json или .zip — например, OptiFine или Fabric из официального установщика.",
                    "Свои версии запускаются как обычные, а ненужную можно удалить в корзину.",
                    "Без интернета список показывает установленные версии и последний сохранённый список, а Fabric, Forge и другие загрузчики запускаются с диска.",
                    "Запуск больше не зависает, если серверы загрузчиков не отвечают."
                ],
                en: [
                    "New version picker: search plus Vanilla / Fabric / Forge / NeoForge / Quilt / OptiFine / Custom tabs with counts.",
                    "Sorting: newest, oldest, by name, installed first or favorites first.",
                    "Add your own version with the “Custom version” button or drop a version folder, .json or .zip into the window — e.g. OptiFine or Fabric from the official installer.",
                    "Custom versions launch like regular ones and can be moved to the Recycle Bin.",
                    "Offline, the list shows installed versions and the last saved list, and Fabric, Forge and other loaders launch from disk.",
                    "Launching no longer hangs when loader servers do not respond."
                ]
            }
        },
        {
            id: "2.7.0-crash-analyzer-mods",
            version: "2.7.0",
            date: "2026-10-24T22:00:00+03:00",
            image: "assets/version-heroes/1.21.png",
            tag: {ru: "БОЛЬШОЕ ОБНОВЛЕНИЕ", en: "MAJOR UPDATE"},
            title: {ru: "Разбор вылетов и умный менеджер модов", en: "Crash analysis and a smarter mod manager"},
            summary: {
                ru: "Лаунчер объясняет, почему игра вылетела и как это исправить, а моды можно перетаскивать прямо в окно и проверять их совместимость.",
                en: "The launcher now explains why the game crashed and how to fix it, and mods can be dropped straight into the window with a compatibility check."
            },
            changes: {
                ru: [
                    "После вылета открывается разбор: нехватка зависимостей, конфликты модов, неверная Java, память, видеодрайвер — с шагами решения и кнопкой «Отключить мод».",
                    "Моды можно перетащить прямо в окно лаунчера — они сразу попадут в папку выбранной версии.",
                    "«Подробнее» у каждого мода: версия, авторы, загрузчик и примерная совместимость с выбранной версией.",
                    "Сортировка модов по названию, дате, размеру и «сначала проблемные».",
                    "Серверы показывают иконки и MOTD по мере ответа, а не после загрузки всего списка.",
                    "Режим паранойи: без телеметрии и ID компьютера, без сторонних аватарок, без ника в Discord, с маскировкой имени пользователя в логах.",
                    "Новые уведомления, палитра цветов, меню профилей с перетаскиванием; убраны «Комнаты» и выбор аватарок.",
                    "Во время игры лаунчер выгружает картинки и 3D-просмотр и отдаёт память Minecraft."
                ],
                en: [
                    "After a crash a breakdown opens: missing dependencies, mod conflicts, wrong Java, memory, graphics driver — with fix steps and a “Disable mod” button.",
                    "Drop mods straight into the launcher window — they go to the selected version's folder.",
                    "“More info” for every mod: version, authors, loader and estimated compatibility with the selected version.",
                    "Sort mods by name, date, size or “problems first”.",
                    "Servers show icons and MOTD as soon as each responds instead of after the whole list.",
                    "Paranoia mode: no telemetry or machine ID, no third-party avatars, no nickname in Discord, user name masked in logs.",
                    "New notifications, color palette and drag-to-reorder profiles; LAN rooms and avatar picker removed.",
                    "While the game runs the launcher unloads images and the 3D viewer to leave memory for Minecraft."
                ]
            }
        },
        {
            id: "2.6.0-lan-rooms-performance",
            version: "2.6.0",
            date: "2026-09-24T18:00:00+03:00",
            image: "assets/version-heroes/1.21.png",
            tag: {ru: "НОВОЕ", en: "NEW"},
            title: {
                ru: "Комнаты друзей и ускорение лаунчера",
                en: "Friends' LAN rooms and launcher performance"
            },
            summary: {
                ru: "Появились комнаты для игры в одной сети: открытие мира, автоматический поиск друзей и подключение по адресу. Лаунчер стал легче, а при запуске игры скрывается из панели задач и доступен через трей.",
                en: "LAN rooms now discover friends' worlds and support direct addresses. The launcher uses fewer effects and hides from the taskbar during play, remaining accessible in the tray."
            },
            changes: {
                ru: [
                    "Новая вкладка «Комнаты» обнаруживает открытые миры RxLaunch в одной сети без отдельной регистрации.",
                    "Можно открыть свою LAN-комнату, добавить комнату друга в Minecraft или запустить игру сразу с нужным адресом.",
                    "Для ручного подключения добавлены адрес и порт; для разных сетей требуется VPN или проброс порта.",
                    "Исправлена задержка скрытия окна после запуска игры: значок пропадает из панели задач и остаётся только в трее.",
                    "Убраны тяжёлые постоянно перерисовываемые эффекты и принудительная сборка мусора; 3D-библиотека скинов загружается только при открытии вкладки.",
                    "Терминал теперь пакетно обновляет строки, а история логов ограничена по размеру."
                ],
                en: [
                    "Added LAN room discovery for friends on the same network without another account.",
                    "Host an opened LAN world, save a friend's room to Minecraft or launch directly to its address.",
                    "Manual address and port are supported; different networks need a VPN or port forwarding.",
                    "The launcher now hides promptly from the taskbar during gameplay and remains available in the tray.",
                    "Removed expensive continuous visual effects and forced garbage collection; the 3D skin library loads on demand.",
                    "The terminal batches line rendering and limits the in-memory log size."
                ]
            }
        },
        {
            id: "2.5.0-interface-mods",
            version: "2.5.0",
            date: "2026-08-24T18:00:00+03:00",
            image: "assets/version-heroes/1.21.png",
            tag: {ru: "БОЛЬШОЕ ОБНОВЛЕНИЕ", en: "MAJOR UPDATE"},
            title: {ru: "Новый интерфейс и менеджер модов", en: "New interface and mod manager"},
            summary: {
                ru: "Главная страница полностью перестроена: версия меняет кинематографичную обложку, новости получили изображения, а вместо модпаков появился локальный менеджер JAR-модов.",
                en: "The home screen has been rebuilt: versions switch cinematic artwork, news cards now have images, and the modpacks tab is replaced by a local JAR mod manager."
            },
            changes: {
                ru: [
                    "Добавлены локальные реалистичные voxel-обложки для Minecraft 1.18, 1.19, 1.20 и 1.21.",
                    "Выбранная версия моментально меняет сцену, название эпохи, загрузчик и подписи главной страницы.",
                    "Новая вкладка «Моды» показывает JAR-файлы выбранной версии, умеет добавлять, отключать, удалять и сохранять ZIP-копию.",
                    "Локальные профили можно переименовывать без потери UUID, скина и статистики.",
                    "Терминал получил мгновенное добавление строк, поиск, уровни событий и умную автопрокрутку.",
                    "Новости стали визуальными карточками с изображениями и сохранили офлайн-листание."
                ],
                en: [
                    "Added local realistic voxel artwork for Minecraft 1.18, 1.19, 1.20 and 1.21.",
                    "The selected version instantly changes the scene, era title, loader and home metadata.",
                    "The new Mods tab lists JAR files for the selected version and can add, disable, delete and export a ZIP backup.",
                    "Local profiles can be renamed without losing their UUID, skin or statistics.",
                    "The terminal now appends lines instantly and adds search, event levels and smart auto-scroll.",
                    "News is presented as visual cards with images while offline pagination remains available."
                ]
            }
        },
        {
            id: "2.4.0-skins-personalization",
            version: "2.4.0",
            date: "2026-08-20T21:00:00+03:00",
            image: "assets/version-heroes/1.20.png",
            tag: {ru: "НОВОЕ", en: "NEW"},
            title: {ru: "3D-скины и новая персонализация", en: "3D skins and new personalization"},
            summary: {
                ru: "Появился отдельный поиск Java-скинов с 3D-просмотром, а оформление получило десять новых аватарок, три фона и расширенную палитру.",
                en: "A dedicated Java skin search with a 3D preview is now available, alongside ten new avatars, three wallpapers and an expanded color palette."
            },
            changes: {
                ru: [
                    "Поиск скина работает по нику через официальные сервисы Minecraft и сохраняет проверенный кэш на ПК.",
                    "Модель можно вращать мышью, масштабировать колесом и скачать как исходный PNG.",
                    "Найденный скин можно использовать как локальный аватар выбранного профиля RxLauncher.",
                    "Добавлены текущая классическая и десять новых разных аватарок лаунчера с безопасным обновлением окна и ярлыков Windows.",
                    "Добавлены три новых фона, одиннадцать дополнительных цветов и автоматическое согласование цвета темы с аватаркой."
                ],
                en: [
                    "Nickname search uses official Minecraft services and stores a verified local cache.",
                    "The model can be rotated, zoomed and downloaded as its original PNG texture.",
                    "A found skin can be used as the local avatar of the selected RxLauncher profile.",
                    "The classic icon and ten distinct launcher avatars now safely update the window and Windows shortcuts.",
                    "Added three wallpapers, eleven extra accent colors and optional avatar-to-theme color matching."
                ]
            }
        },
        {
            id: "2.3.2-server-navigation",
            version: "2.3.2",
            date: "2026-08-01T22:00:00+03:00",
            tag: {ru: "ФИКСЫ", en: "FIXES"},
            title: {ru: "Исправлено открытие серверов", en: "Server navigation fixed"},
            summary: {
                ru: "Кнопка «Сервера» теперь всегда открывает вкладку сразу, даже если проверка подключения отвечает медленно или временно завершается ошибкой.",
                en: "The Servers button now opens its tab immediately, even when the connectivity check is slow or temporarily fails."
            },
            changes: {
                ru: [
                    "Убрана блокирующая проверка сети до перехода во вкладку.",
                    "При отсутствии интернета вкладка показывает понятное офлайн-состояние вместо игнорирования клика.",
                    "Добавлен автоматический тест настоящего клика при включённом приватном режиме."
                ],
                en: [
                    "Removed the blocking connectivity check before navigation.",
                    "When offline, the tab now shows a clear offline state instead of ignoring the click.",
                    "Added an automated real-click regression test with privacy mode enabled."
                ]
            }
        },
        {
            id: "2.3.2-network-compatibility",
            version: "2.3.2",
            date: "2026-08-10T12:00:00+03:00",
            tag: {ru: "СЕТЬ", en: "NETWORK"},
            title: {ru: "Безопасный фикс сетевой игры", en: "Safe network-game fix"},
            summary: {
                ru: "Добавлена проверка официальных сервисов Minecraft и восстановлена безопасная настройка совместимости сети.",
                en: "Added an official Minecraft services preflight and restored the safe network compatibility setting."
            },
            changes: {
                ru: [
                    "Режим предпочитает IPv4 и задаёт безопасные тайм-ауты Java.",
                    "Кнопка «Проверить подключение» показывает, доступны ли сервисы Mojang.",
                    "Старая настройка multiplayerFix переносится автоматически без подмены серверов авторизации.",
                    "Зависимости модов по-прежнему скачиваются отдельной настройкой автозагрузки обязательных зависимостей."
                ],
                en: [
                    "The mode prefers IPv4 and applies safe Java network timeouts.",
                    "The Check connection button reports whether Mojang services are reachable.",
                    "The old multiplayerFix setting is migrated without replacing authentication servers.",
                    "Mod dependencies remain controlled by the separate automatic required-dependencies setting."
                ]
            }
        },
        {
            id: "2.3.1-server-status-installer",
            version: "2.3.1",
            date: "2026-08-01T20:00:00+03:00",
            tag: {ru: "ФИКСЫ", en: "FIXES"},
            title: {ru: "Статусы серверов и новый установщик", en: "Server statuses and new installer"},
            summary: {
                ru: "Онлайн, MOTD и иконки снова отображаются при явном открытии каталога, а установщик получил полностью новое фирменное оформление RxLauncher.",
                en: "Player counts, MOTD and icons now appear whenever the catalog is opened, and the installer has a completely new RxLauncher look."
            },
            changes: {
                ru: [
                    "Исправлен конфликт с приватным режимом: он больше не скрывает статусы в открытой вкладке серверов.",
                    "Фоновые проверки по-прежнему отключаются приватным режимом, а прямой запуск сервера остаётся защищённым.",
                    "Добавлены независимая загрузка favicon, понятное состояние ошибки и повтор запроса для отдельного сервера.",
                    "Установщик получил новую боковую иллюстрацию, шапку, фирменные цвета и улучшенные тексты всех шагов."
                ],
                en: [
                    "Fixed the privacy-mode conflict that hid statuses from the open Servers tab.",
                    "Privacy mode still disables background polling and keeps direct server launch protected.",
                    "Added independent favicon loading, a clear error state and per-server retry.",
                    "The installer now has new sidebar art, header artwork, brand colors and improved step text."
                ]
            }
        },
        {
            id: "2.3.0-server-catalog",
            version: "2.3.0",
            date: "2026-08-01T18:00:00+03:00",
            tag: {ru: "НОВОЕ", en: "NEW"},
            title: {ru: "Живой каталог серверов", en: "Live server catalog"},
            summary: {
                ru: "Категории Anarchy, Grief и BoxPvP получили живой онлайн, MOTD, иконки, графики и добавление прямо в Minecraft.",
                en: "Anarchy, Grief and BoxPvP categories now have live player counts, MOTD, icons, charts and one-click Minecraft sync."
            },
            changes: {
                ru: [
                    "Добавлены FunTime, HolyWorld, ReallyWorld и все указанные BoxPvP/Grief серверы.",
                    "Появились поиск, фильтры категорий и сортировка по текущему онлайну.",
                    "Пик, средний онлайн и график сохраняются локально за 30 дней.",
                    "Свои серверы безопасно добавляются в servers.dat с резервной копией и без дублей.",
                    "Без подключения вкладка серверов не открывается; статусы имеют резервный API.",
                    "Discord показывает ник только после реального запуска игры.",
                    "ForgeOptiFine получил официальный источник и локальный список из 34 версий."
                ],
                en: [
                    "Added FunTime, HolyWorld, ReallyWorld and every requested BoxPvP/Grief server.",
                    "Added search, category filters and live-player sorting.",
                    "Peak, average and chart history are stored locally for 30 days.",
                    "Custom servers are safely merged into servers.dat with backup and deduplication.",
                    "The Servers tab stays closed without connectivity and status queries have a fallback API.",
                    "Discord shows the nickname only after the game process actually starts.",
                    "ForgeOptiFine now uses the official source and a local 34-version fallback list."
                ]
            }
        },
        {
            id: "2.2.0-player-statistics",
            version: "2.2.0",
            date: "2026-07-29T18:00:00+03:00",
            tag: {ru: "НОВОЕ", en: "NEW"},
            title: {ru: "Статистика игрока", en: "Player statistics"},
            summary: {
                ru: "Новый красивый центр статистики с часами, киллами, смертями, сериями, любимыми серверами, никами и мирами.",
                en: "A new statistics hub with playtime, kills, deaths, streaks, favorite servers, nicknames and worlds."
            },
            changes: {
                ru: [
                    "Добавлена отдельная категория «Статистика» в боковом меню.",
                    "Статистика сохраняется на ПК в отдельный файл с резервной копией и восстановлением после сбоя.",
                    "Добавлены фильтры за всё время, 30 дней, 7 дней, сегодня и по игровому нику.",
                    "Добавлены топ-3 серверов, ников и миров, график активности и листаемая история сессий.",
                    "Исправлен запуск счётчика: неудачный запуск Java больше не считается игровой сессией.",
                    "Лента патчей теперь работает без интернета и листается кнопками."
                ],
                en: [
                    "Added a dedicated Statistics category to the sidebar.",
                    "Statistics are stored locally with a backup and crash recovery.",
                    "Added all-time, 30-day, 7-day, today and nickname filters.",
                    "Added top servers, nicknames and worlds, an activity chart and paged session history.",
                    "Failed Java launches are no longer counted as game sessions.",
                    "The patch feed now works offline and has explicit pagination."
                ]
            }
        },
        {
            id: "2.1.17-discord-rpc",
            version: "2.1.17",
            date: "2026-07-29T16:30:00+03:00",
            tag: {ru: "ПАТЧ", en: "PATCH"},
            title: {ru: "Обновлённый Discord RPC", en: "Improved Discord RPC"},
            summary: {
                ru: "Ник теперь заметен в основной строке игрового статуса, а красивая анимированная аватарка RxLaunch сохранена.",
                en: "The nickname is now visible in the primary game status line while the animated RxLaunch artwork stays in place."
            },
            changes: {
                ru: ["Ник показывается и обновляется надёжнее.", "Сервер вынесен в отдельную строку.", "Добавлена кнопка Telegram и сохранена GIF-аватарка."],
                en: ["Nickname display and updates are more reliable.", "Server information has its own line.", "Added the Telegram button and kept the animated artwork."]
            }
        },
        {
            id: "2.1.16-catalog-network",
            version: "2.1.16",
            date: "2026-07-28T20:00:00+03:00",
            tag: {ru: "ПАТЧ", en: "PATCH"},
            title: {ru: "CurseForge и совместимость сети", en: "CurseForge and network compatibility"},
            summary: {
                ru: "Добавлен каталог CurseForge и безопасный режим сетевой совместимости для проблемных подключений.",
                en: "Added the CurseForge catalog and a safe network compatibility mode for problematic connections."
            },
            changes: {
                ru: ["Поиск и установка контента CurseForge.", "Защищённое хранение API-ключа.", "Настраиваемое предпочтение IPv4 и безопасные таймауты."],
                en: ["CurseForge content search and installation.", "Protected API-key storage.", "Optional IPv4 preference and safe timeouts."]
            }
        },
        {
            id: "2.1.15-redesign",
            version: "2.1.15",
            date: "2026-07-27T19:00:00+03:00",
            tag: {ru: "ДИЗАЙН", en: "DESIGN"},
            title: {ru: "Новый визуальный стиль", en: "New visual style"},
            summary: {
                ru: "Интерфейс получил стеклянные панели, мягкие анимации, обновлённые карточки и более удобную компоновку.",
                en: "The interface received glass panels, smoother motion, refreshed cards and a cleaner layout."
            },
            changes: {
                ru: ["Обновлена боковая панель и главный экран.", "Улучшены состояния кнопок и окон.", "Эффекты подстраиваются под выбранную тему."],
                en: ["Updated sidebar and home screen.", "Improved button and modal states.", "Effects adapt to the selected theme."]
            }
        },
        {
            id: "2.1.14-launch-stability",
            version: "2.1.14",
            date: "2026-07-26T18:00:00+03:00",
            tag: {ru: "ФИКСЫ", en: "FIXES"},
            title: {ru: "Стабильность запуска", en: "Launch stability"},
            summary: {
                ru: "Исправлены зависания интерфейса после ошибок запуска и восстановление кнопки «Играть».",
                en: "Fixed interface lockups after launch errors and restored the Play button state correctly."
            },
            changes: {
                ru: ["Единое восстановление интерфейса после ошибки.", "Безопасная проверка выбранной версии.", "Улучшены диагностические сообщения."],
                en: ["Unified UI recovery after errors.", "Safer selected-version validation.", "Improved diagnostic messages."]
            }
        },
        {
            id: "2.1.13-profile-safety",
            version: "2.1.13",
            date: "2026-07-25T18:00:00+03:00",
            tag: {ru: "ФИКСЫ", en: "FIXES"},
            title: {ru: "Профили и приватность", en: "Profiles and privacy"},
            summary: {
                ru: "Улучшено локальное хранение профилей, проверка ников и режим приватности серверов.",
                en: "Improved local profile storage, nickname validation and server privacy controls."
            },
            changes: {
                ru: ["Повреждённые файлы профилей сохраняются в резервную копию.", "Добавлена строгая проверка ника.", "Сетевые запросы отключаются режимом приватности."],
                en: ["Corrupted profile files are backed up.", "Added strict nickname validation.", "Privacy mode disables background network requests."]
            }
        }
    ];

    static language = () => {
        const language = String(typeof RxTranslator !== "undefined" ? RxTranslator.getCurrentLanguage() : "ru").toLowerCase();
        return language === "ru" ? "ru" : "en";
    };

    static localized = (value) => {
        if (typeof value === "string") return value;
        const language = RxPatchNotes.language();
        return value?.[language] || value?.en || value?.ru || "";
    };

    static locale = () => {
        return RxPatchNotes.language() === "ru" ? "ru-RU" : "en-US";
    };

    static getAll = () => RxPatchNotes.ITEMS.map(item => ({
        id: item.id,
        version: item.version,
        date: item.date,
        image: item.image || "assets/version-heroes/1.18.png",
        tag: RxPatchNotes.localized(item.tag),
        title: RxPatchNotes.localized(item.title),
        summary: RxPatchNotes.localized(item.summary),
        changes: RxPatchNotes.localized(item.changes)
    }));

    static formatDate = (value) => new Intl.DateTimeFormat(
        RxPatchNotes.locale(),
        {day: "numeric", month: "long", year: "numeric"}
    ).format(new Date(value));
}
