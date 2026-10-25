// RxLauncher — собственный установщик и деинсталлятор (чёрный минималистичный).
// Окно целиком рисуется вручную (GDI+). Внутри установщика лежит обычный NSIS-установщик electron-builder:
// он запускается тихо (/S), поэтому автообновления работают как раньше.
// Без встроенного NSIS (или с --uninstall) программа работает как деинсталлятор: её открывает
// «Uninstall RxLauncher.exe» при обычном запуске, а удаление файлов идёт тем же NSIS в тихом режиме.
// Собирается скриптом build-installer.cjs (csc из .NET Framework 4.x, C# 5).
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Text;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

[assembly: AssemblyTitle("RxLauncher Setup")]
[assembly: AssemblyProduct("RxLauncher")]
[assembly: AssemblyCompany("MaxRx")]
[assembly: AssemblyDescription("RxLauncher installer")]

namespace RxSetup
{
    internal static class Program
    {
        [STAThread]
        private static void Main()
        {
            // Деинсталлятор, запущенный прямо из папки лаунчера, сначала уходит во временную папку:
            // иначе он не даст удалить саму папку
            if (SetupForm.IsUninstallMode() && SetupForm.RelaunchFromTempIfNeeded()) return;
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new SetupForm());
        }
    }

    // Тексты на русском и английском
    internal sealed class Texts
    {
        public string Eyebrow, Title, Subtitle, Description, FolderLabel, Change, Shortcut, Install,
            InstallingTitle, Extracting, Copying, Finishing, Hint, DoneTitle, DoneText, Launch, Close,
            ErrorTitle, ErrorText, Retry, RunningTitle, RunningText, CloseLauncher, PickFolder, Upgrade,
            TabsLabel, TabsCustomize, TabsEyebrow, TabsTitle, TabsText, TabsDone, Always,
            UEyebrow, UTitle, UText, UDeleteSettings, UButton, Cancel, UninstallingTitle, URemoving,
            UDoneTitle, UDoneText, UDoneTextSettings, UHint;
        public Dictionary<string, string> TabNames = new Dictionary<string, string>();

        public static Texts Create()
        {
            string lang = CultureInfo.CurrentUICulture.TwoLetterISOLanguageName;
            bool ru = lang == "ru" || lang == "uk" || lang == "be" || lang == "kk";
            Texts t = new Texts();
            if (ru)
            {
                t.Eyebrow = "УСТАНОВКА"; t.Title = "RxLauncher";
                t.Subtitle = "Версия {0} · лаунчер Minecraft";
                t.Description = "Сборки, моды с Modrinth, скины и серверы — в одном минималистичном лаунчере.";
                t.FolderLabel = "Папка установки"; t.Change = "Изменить"; t.Shortcut = "Ярлык на рабочем столе";
                t.Install = "Установить"; t.Upgrade = "Обновить";
                t.InstallingTitle = "Устанавливаем…"; t.Extracting = "Распаковываем установщик";
                t.Copying = "Копируем файлы лаунчера"; t.Finishing = "Создаём ярлыки";
                t.Hint = "Обычно это занимает меньше минуты";
                t.DoneTitle = "Готово"; t.DoneText = "RxLauncher установлен. Можно играть.";
                t.Launch = "Запустить RxLauncher"; t.Close = "Закрыть";
                t.ErrorTitle = "Не получилось"; t.ErrorText = "Операция прервалась (код {0}). Попробуйте ещё раз.";
                t.Retry = "Повторить";
                t.RunningTitle = "Лаунчер запущен"; t.RunningText = "Сначала нужно закрыть RxLauncher. Если вы сейчас в игре — выйдите из мира.";
                t.CloseLauncher = "Закрыть и продолжить"; t.PickFolder = "Папка для RxLauncher";
                t.TabsLabel = "Вкладки в меню: {0} из {1}"; t.TabsCustomize = "Настроить";
                t.TabsEyebrow = "НАСТРОЙКА"; t.TabsTitle = "Вкладки меню";
                t.TabsText = "Что будет в боковом меню. Это можно поменять и потом — в настройках лаунчера.";
                t.TabsDone = "Готово"; t.Always = "всегда";
                t.UEyebrow = "УДАЛЕНИЕ"; t.UTitle = "Удалить RxLauncher?";
                t.UText = "Лаунчер будет удалён из папки {0}. Миры, моды и сборки в папке игры останутся.";
                t.UDeleteSettings = "Удалить также настройки и аккаунты лаунчера"; t.UButton = "Удалить"; t.Cancel = "Отмена";
                t.UninstallingTitle = "Удаляем…"; t.URemoving = "Удаляем файлы лаунчера"; t.UHint = "Это займёт несколько секунд";
                t.UDoneTitle = "RxLauncher удалён"; t.UDoneText = "Спасибо, что играли! Миры и сборки в папке игры сохранены.";
                t.UDoneTextSettings = "Лаунчер и его настройки удалены. Миры и сборки в папке игры сохранены.";
                t.TabNames["content"] = "Главная"; t.TabNames["settings"] = "Настройки"; t.TabNames["instances"] = "Сборки";
                t.TabNames["mods"] = "Моды"; t.TabNames["skins"] = "Скины"; t.TabNames["servers"] = "Серверы";
                t.TabNames["statistics"] = "Статистика"; t.TabNames["screenshots"] = "Скриншоты"; t.TabNames["console"] = "Консоль";
            }
            else
            {
                t.Eyebrow = "SETUP"; t.Title = "RxLauncher";
                t.Subtitle = "Version {0} · Minecraft launcher";
                t.Description = "Instances, Modrinth mods, skins and servers — in one minimal launcher.";
                t.FolderLabel = "Install folder"; t.Change = "Change"; t.Shortcut = "Desktop shortcut";
                t.Install = "Install"; t.Upgrade = "Update";
                t.InstallingTitle = "Installing…"; t.Extracting = "Unpacking the installer";
                t.Copying = "Copying launcher files"; t.Finishing = "Creating shortcuts";
                t.Hint = "This usually takes less than a minute";
                t.DoneTitle = "All set"; t.DoneText = "RxLauncher is installed. Time to play.";
                t.Launch = "Launch RxLauncher"; t.Close = "Close";
                t.ErrorTitle = "Something went wrong"; t.ErrorText = "The operation stopped (code {0}). Please try again.";
                t.Retry = "Try again";
                t.RunningTitle = "The launcher is running"; t.RunningText = "RxLauncher has to be closed first. If you are playing, leave your world.";
                t.CloseLauncher = "Close it and continue"; t.PickFolder = "Folder for RxLauncher";
                t.TabsLabel = "Menu tabs: {0} of {1}"; t.TabsCustomize = "Customize";
                t.TabsEyebrow = "SETUP"; t.TabsTitle = "Menu tabs";
                t.TabsText = "What appears in the sidebar. You can change it later in the launcher settings.";
                t.TabsDone = "Done"; t.Always = "always";
                t.UEyebrow = "UNINSTALL"; t.UTitle = "Remove RxLauncher?";
                t.UText = "The launcher will be removed from {0}. Worlds, mods and instances in the game folder stay.";
                t.UDeleteSettings = "Also delete launcher settings and accounts"; t.UButton = "Remove"; t.Cancel = "Cancel";
                t.UninstallingTitle = "Removing…"; t.URemoving = "Removing launcher files"; t.UHint = "This takes a few seconds";
                t.UDoneTitle = "RxLauncher removed"; t.UDoneText = "Thanks for playing! Worlds and instances in the game folder are kept.";
                t.UDoneTextSettings = "The launcher and its settings are removed. Worlds and instances in the game folder are kept.";
                t.TabNames["content"] = "Home"; t.TabNames["settings"] = "Settings"; t.TabNames["instances"] = "Instances";
                t.TabNames["mods"] = "Mods"; t.TabNames["skins"] = "Skins"; t.TabNames["servers"] = "Servers";
                t.TabNames["statistics"] = "Statistics"; t.TabNames["screenshots"] = "Screenshots"; t.TabNames["console"] = "Console";
            }
            return t;
        }
    }

    internal enum Screen { Welcome, Tabs, Running, Installing, Done, Error, UConfirm, Uninstalling, UDone }

    internal sealed class SetupForm : Form
    {
        // ---------- палитра ----------
        private static readonly Color Bg = Color.FromArgb(10, 10, 11);
        private static readonly Color Panel = Color.FromArgb(21, 21, 24);
        private static readonly Color Stroke = Color.FromArgb(36, 36, 41);
        private static readonly Color StrokeHover = Color.FromArgb(60, 60, 68);
        private static readonly Color TextMain = Color.FromArgb(242, 242, 244);
        private static readonly Color TextSub = Color.FromArgb(138, 138, 148);
        private static readonly Color TextBody = Color.FromArgb(178, 178, 186);
        private static readonly Color Accent = Color.FromArgb(229, 57, 53);
        private static readonly Color AccentHover = Color.FromArgb(240, 78, 74);
        private static readonly Color AccentPressed = Color.FromArgb(205, 45, 42);

        private const int W = 780, H = 480, ArtW = 300;
        private const float X0 = 344, CW = 392; // колонка контента

        // Вкладки бокового меню лаунчера (data-modal). Главная и Настройки отключить нельзя
        private static readonly string[] AllTabs = { "content", "settings", "instances", "mods", "skins", "servers", "statistics", "screenshots", "console" };
        private static readonly string[] LockedTabs = { "content", "settings" };
        private static readonly string[] DefaultTabs = { "content", "settings", "statistics", "console" };

        private readonly Texts T = Texts.Create();
        private readonly string version;
        private readonly long expectedBytes;
        private readonly Image art, logo;
        private readonly bool uninstallMode;
        private float s = 1f; // масштаб под DPI

        private Screen screen;
        private string installDir;
        private bool upgrade, desktopShortcut = true, deleteSettings, canDeleteSettings;
        private readonly HashSet<string> tabs = new HashSet<string>();
        private string status = "", errorCode = "";
        private float progressTarget, progressShown;
        private int exitCode;
        private string hover = "", pressed = "";
        private readonly Dictionary<string, RectangleF> hits = new Dictionary<string, RectangleF>();
        private readonly System.Windows.Forms.Timer frame = new System.Windows.Forms.Timer();
        private float fade;

        private Font fEyebrow, fTitle, fSub, fBody, fSmall, fButton, fBrand, fIcon, fIconSmall;

        // ---------- режим и временная копия деинсталлятора ----------
        public static bool IsUninstallMode()
        {
            if (Environment.GetCommandLineArgs().Contains("--uninstall")) return true;
            string preview = ArgValue("--preview");
            if (preview != null) return preview.StartsWith("u");
            return Assembly.GetExecutingAssembly().GetManifestResourceInfo("payload.exe") == null;
        }

        private static string ArgValue(string name)
        {
            foreach (string arg in Environment.GetCommandLineArgs())
                if (arg.StartsWith(name + "=")) return arg.Substring(name.Length + 1);
            return null;
        }

        public static bool RelaunchFromTempIfNeeded()
        {
            string self = Assembly.GetExecutingAssembly().Location;
            string temp = Path.GetFullPath(Path.GetTempPath());
            if (ArgValue("--preview") != null || self.StartsWith(temp, StringComparison.OrdinalIgnoreCase)) return false;
            string dir = ArgValue("--dir") ?? Path.GetDirectoryName(Path.GetDirectoryName(self)); // <папка>\resources\RxUninstall.exe
            string copy = Path.Combine(temp, "RxUninstall-" + Guid.NewGuid().ToString("N") + ".exe");
            try
            {
                File.Copy(self, copy);
                Process.Start(new ProcessStartInfo(copy, "--uninstall \"--dir=" + dir + "\"") { UseShellExecute = false });
                return true;
            }
            catch
            {
                return false;
            }
        }

        public SetupForm()
        {
            Assembly asm = Assembly.GetExecutingAssembly();
            version = ReadText(asm, "version.txt", "2");
            long.TryParse(ReadText(asm, "size.txt", "0"), out expectedBytes);
            art = LoadImage(asm, "installer-art.png");
            logo = LoadImage(asm, "logo.png");
            using (Stream icon = asm.GetManifestResourceStream("icon.ico")) { if (icon != null) Icon = new Icon(icon); }

            uninstallMode = IsUninstallMode();
            installDir = ArgValue("--dir") ?? DetectInstallDir(out upgrade);
            if (ArgValue("--dir") != null) upgrade = Directory.Exists(installDir);
            screen = uninstallMode ? Screen.UConfirm : Screen.Welcome;
            canDeleteSettings = CanDeleteSettings();
            foreach (string tab in ReadSavedTabs() ?? DefaultTabs) tabs.Add(tab);
            foreach (string tab in LockedTabs) tabs.Add(tab);

            Text = uninstallMode ? "RxLauncher Uninstall" : "RxLauncher Setup";
            FormBorderStyle = FormBorderStyle.None;
            StartPosition = FormStartPosition.CenterScreen;
            BackColor = Bg;
            DoubleBuffered = true;
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
            KeyPreview = true;
            Opacity = 0;

            using (Graphics g = CreateGraphics()) { s = g.DpiX / 96f; }
            ClientSize = new Size(Px(W), Px(H));
            BuildFonts();

            // Просмотр экранов без установки (для проверки дизайна)
            string preview = ArgValue("--preview");
            if (preview == "installing") { screen = Screen.Installing; status = T.Copying; progressTarget = progressShown = 0.62f; }
            if (preview == "done") screen = Screen.Done;
            if (preview == "error") { screen = Screen.Error; errorCode = "2"; }
            if (preview == "running") screen = Screen.Running;
            if (preview == "tabs") screen = Screen.Tabs;
            if (preview == "uninstalling") { screen = Screen.Uninstalling; status = T.URemoving; progressTarget = progressShown = 0.4f; }
            if (preview == "udone") screen = Screen.UDone;

            frame.Interval = 15;
            frame.Tick += delegate
            {
                bool dirty = false;
                if (fade < 1f) { fade = Math.Min(1f, fade + 0.09f); Opacity = fade; }
                if (Math.Abs(progressTarget - progressShown) > 0.001f)
                {
                    progressShown += (progressTarget - progressShown) * 0.12f;
                    dirty = true;
                }
                if (screen == Screen.Installing || screen == Screen.Uninstalling) dirty = true;
                if (dirty) Invalidate();
            };
            frame.Start();
        }

        // ---------- ресурсы ----------
        private static string ReadText(Assembly asm, string name, string fallback)
        {
            using (Stream stream = asm.GetManifestResourceStream(name))
            {
                if (stream == null) return fallback;
                using (StreamReader reader = new StreamReader(stream)) return reader.ReadToEnd().Trim();
            }
        }

        private static Image LoadImage(Assembly asm, string name)
        {
            Stream stream = asm.GetManifestResourceStream(name);
            return stream == null ? null : Image.FromStream(stream);
        }

        private int Px(float value) { return (int)Math.Round(value * s); }

        private void BuildFonts()
        {
            string family = FontExists("Segoe UI Variable Display") ? "Segoe UI Variable Display" : "Segoe UI";
            string semibold = FontExists("Segoe UI Semibold") ? "Segoe UI Semibold" : family;
            fEyebrow = new Font(semibold, 8f, FontStyle.Regular);
            fTitle = new Font(family, 28f, FontStyle.Bold);
            fSub = new Font(family, 10.5f, FontStyle.Regular);
            fBody = new Font(family, 10f, FontStyle.Regular);
            fSmall = new Font(family, 9f, FontStyle.Regular);
            fButton = new Font(semibold, 10.5f, FontStyle.Regular);
            fBrand = new Font(semibold, 10.5f, FontStyle.Regular);
            fIcon = new Font("Segoe MDL2 Assets", 9f, FontStyle.Regular);
            fIconSmall = new Font("Segoe MDL2 Assets", 7f, FontStyle.Regular);
        }

        private static bool FontExists(string name)
        {
            using (Font font = new Font(name, 10f)) return string.Equals(font.Name, name, StringComparison.OrdinalIgnoreCase);
        }

        // ---------- настройки лаунчера (%APPDATA%\rxclient) ----------
        private static string UserDataDir()
        {
            return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "rxclient");
        }

        private static string ReadLauncherConfig()
        {
            try { return File.ReadAllText(Path.Combine(UserDataDir(), "config.json")); } catch { return ""; }
        }

        // Уже выбранные в лаунчере вкладки — чтобы обновление их не сбрасывало
        private static string[] ReadSavedTabs()
        {
            Match match = Regex.Match(ReadLauncherConfig(), "\"enabledTabs\"\\s*:\\s*\\[([^\\]]*)\\]");
            if (!match.Success) return null;
            string[] values = Regex.Matches(match.Groups[1].Value, "\"([a-z]+)\"").Cast<Match>().Select(m => m.Groups[1].Value).Where(v => AllTabs.Contains(v)).ToArray();
            return values.Length > 0 ? values : null;
        }

        // Удалять настройки можно, только если папка игры не лежит внутри них
        private static bool CanDeleteSettings()
        {
            if (!Directory.Exists(UserDataDir())) return false;
            Match match = Regex.Match(ReadLauncherConfig(), "\"gameDirectory\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"");
            if (!match.Success) return true;
            string game = Regex.Unescape(match.Groups[1].Value);
            try
            {
                return !Path.GetFullPath(game).StartsWith(Path.GetFullPath(UserDataDir()), StringComparison.OrdinalIgnoreCase);
            }
            catch { return false; }
        }

        private void SaveTabsChoice()
        {
            try
            {
                Directory.CreateDirectory(UserDataDir());
                string list = string.Join(",", AllTabs.Where(tab => tabs.Contains(tab)).Select(tab => "\"" + tab + "\"").ToArray());
                // Лаунчер прочитает файл при запуске, перенесёт в config.json и удалит
                File.WriteAllText(Path.Combine(UserDataDir(), "installer-tabs.json"), "{\"enabledTabs\":[" + list + "]}");
            }
            catch { }
        }

        // ---------- окно без рамки: тень, скругление, перетаскивание ----------
        protected override CreateParams CreateParams
        {
            get
            {
                CreateParams cp = base.CreateParams;
                cp.ClassStyle |= 0x20000; // CS_DROPSHADOW
                cp.Style |= 0x20000;      // WS_MINIMIZEBOX — сворачивание из панели задач
                return cp;
            }
        }

        [DllImport("dwmapi.dll")] private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);
        [DllImport("user32.dll")] private static extern bool ReleaseCapture();
        [DllImport("user32.dll")] private static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            try
            {
                int round = 2; // DWMWCP_ROUND — Windows 11
                DwmSetWindowAttribute(Handle, 33, ref round, 4);
                int dark = 1;
                DwmSetWindowAttribute(Handle, 20, ref dark, 4);
            }
            catch { }
        }

        // ---------- поиск прошлой установки ----------
        private static string DetectInstallDir(out bool existing)
        {
            existing = false;
            foreach (RegistryKey hive in new[] { Registry.CurrentUser, Registry.LocalMachine })
            {
                using (RegistryKey key = hive.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Uninstall"))
                {
                    if (key == null) continue;
                    foreach (string name in key.GetSubKeyNames())
                    {
                        using (RegistryKey app = key.OpenSubKey(name))
                        {
                            if (app == null) continue;
                            string display = app.GetValue("DisplayName") as string;
                            if (display == null || !display.StartsWith("RxLauncher")) continue;
                            string location = app.GetValue("InstallLocation") as string;
                            if (string.IsNullOrEmpty(location))
                            {
                                string uninstall = app.GetValue("UninstallString") as string ?? "";
                                int quote = uninstall.IndexOf('"', 1);
                                if (uninstall.StartsWith("\"") && quote > 1) location = Path.GetDirectoryName(uninstall.Substring(1, quote - 1));
                            }
                            if (!string.IsNullOrEmpty(location) && Directory.Exists(location))
                            {
                                existing = true;
                                return location;
                            }
                        }
                    }
                }
            }
            return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "RxLauncher");
        }

        private static string DesktopShortcutPath()
        {
            return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "RxLauncher.lnk");
        }

        // ---------- отрисовка ----------
        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.TextRenderingHint = TextRenderingHint.ClearTypeGridFit;
            g.InterpolationMode = InterpolationMode.HighQualityBicubic;
            g.PixelOffsetMode = PixelOffsetMode.HighQuality;
            hits.Clear();
            g.Clear(Bg);
            g.ScaleTransform(s, s);

            DrawArt(g);
            DrawWindowButtons(g);

            switch (screen)
            {
                case Screen.Welcome: DrawWelcome(g); break;
                case Screen.Tabs: DrawTabs(g); break;
                case Screen.Running: DrawMessage(g, T.RunningTitle, T.RunningText, "warn", "closeLauncher", T.CloseLauncher, "close", T.Close); break;
                case Screen.Installing: DrawProgress(g, T.Eyebrow, T.InstallingTitle, T.Hint); break;
                case Screen.Done: DrawMessage(g, T.DoneTitle, T.DoneText, "ok", "launch", T.Launch, "close", T.Close); break;
                case Screen.Error: DrawMessage(g, T.ErrorTitle, string.Format(T.ErrorText, errorCode), "error", "retry", T.Retry, "close", T.Close); break;
                case Screen.UConfirm: DrawUninstallConfirm(g); break;
                case Screen.Uninstalling: DrawProgress(g, T.UEyebrow, T.UninstallingTitle, T.UHint); break;
                case Screen.UDone: DrawMessage(g, T.UDoneTitle, deleteSettings ? T.UDoneTextSettings : T.UDoneText, "ok", "close", T.Close, null, null); break;
            }
        }

        private void DrawArt(Graphics g)
        {
            RectangleF panel = new RectangleF(0, 0, ArtW, H);
            if (art != null) g.DrawImage(art, panel);
            using (LinearGradientBrush blend = new LinearGradientBrush(new RectangleF(ArtW - 70, 0, 71, H), Color.FromArgb(0, Bg), Bg, LinearGradientMode.Horizontal))
                g.FillRectangle(blend, ArtW - 70, 0, 71, H);
            if (logo != null) g.DrawImage(logo, new RectangleF(24, 22, 26, 26));
            DrawText(g, "RxLauncher", fBrand, TextMain, 58, 25);
        }

        private bool Busy { get { return screen == Screen.Installing || screen == Screen.Uninstalling; } }

        private void DrawWindowButtons(Graphics g)
        {
            RectangleF min = new RectangleF(W - 84, 12, 34, 30);
            RectangleF close = new RectangleF(W - 46, 12, 34, 30);
            Hit("min", min);
            if (!Busy) Hit("x", close);
            if (hover == "min") FillRound(g, min, 8, Color.FromArgb(26, 26, 30));
            if (hover == "x") FillRound(g, close, 8, Color.FromArgb(70, 229, 57, 53));
            DrawCentered(g, "", fIcon, TextSub, min);
            DrawCentered(g, "", fIcon, Busy ? Color.FromArgb(60, 60, 66) : (hover == "x" ? TextMain : TextSub), close);
        }

        private void DrawPrimary(Graphics g, string id, string text, RectangleF rect)
        {
            Hit(id, rect);
            FillRound(g, rect, 13, pressed == id ? AccentPressed : (hover == id ? AccentHover : Accent));
            DrawCentered(g, text, fButton, Color.White, rect);
        }

        private void DrawCheckbox(Graphics g, string id, bool value, string text, float y)
        {
            RectangleF check = new RectangleF(X0, y, 20, 20);
            SizeF label = g.MeasureString(text, fBody);
            Hit(id, new RectangleF(X0 - 4, y - 4, label.Width + 40, 28));
            if (value)
            {
                FillRound(g, check, 6, Accent);
                DrawCentered(g, "", fIcon, Color.White, check);
            }
            else
            {
                FillRound(g, check, 6, Panel);
                StrokeRound(g, check, 6, hover == id ? StrokeHover : Stroke);
            }
            DrawText(g, text, fBody, TextMain, X0 + 30, y + (20 - label.Height) / 2);
        }

        private void DrawWelcome(Graphics g)
        {
            DrawText(g, Spaced(T.Eyebrow), fEyebrow, Accent, X0, 70);
            DrawText(g, T.Title, fTitle, TextMain, X0 - 3, 86);
            DrawText(g, string.Format(T.Subtitle, version), fSub, TextSub, X0, 138);
            DrawWrapped(g, T.Description, fBody, TextBody, new RectangleF(X0, 168, CW - 20, 44));

            // Папка
            DrawText(g, T.FolderLabel, fSmall, TextSub, X0, 226);
            RectangleF box = new RectangleF(X0, 246, CW, 42);
            Hit("folder", box);
            FillRound(g, box, 11, Panel);
            StrokeRound(g, box, 11, hover == "folder" ? StrokeHover : Stroke);
            DrawCentered(g, "", fIcon, TextSub, new RectangleF(box.X + 8, box.Y, 30, box.Height));
            SizeF change = g.MeasureString(T.Change, fSmall);
            DrawEllipsis(g, installDir, fBody, TextMain, new RectangleF(box.X + 38, box.Y, box.Width - 58 - change.Width, box.Height));
            DrawText(g, T.Change, fSmall, hover == "folder" ? AccentHover : Accent, box.Right - change.Width - 12, box.Y + (box.Height - change.Height) / 2);

            DrawCheckbox(g, "shortcut", desktopShortcut, T.Shortcut, 304);

            // Вкладки меню: краткий список + «Настроить»
            RectangleF tabsRow = new RectangleF(X0, 336, CW, 40);
            Hit("tabs", tabsRow);
            FillRound(g, tabsRow, 11, hover == "tabs" ? Color.FromArgb(26, 26, 30) : Panel);
            DrawCentered(g, "", fIcon, TextSub, new RectangleF(tabsRow.X + 8, tabsRow.Y, 30, tabsRow.Height));
            SizeF customize = g.MeasureString(T.TabsCustomize, fSmall);
            DrawEllipsis(g, string.Format(T.TabsLabel, tabs.Count, AllTabs.Length), fBody, TextBody, new RectangleF(tabsRow.X + 38, tabsRow.Y, tabsRow.Width - 58 - customize.Width, tabsRow.Height));
            DrawText(g, T.TabsCustomize, fSmall, hover == "tabs" ? AccentHover : Accent, tabsRow.Right - customize.Width - 12, tabsRow.Y + (tabsRow.Height - customize.Height) / 2);

            DrawPrimary(g, "install", upgrade ? T.Upgrade : T.Install, new RectangleF(X0, 398, CW, 48));
        }

        private void DrawTabs(Graphics g)
        {
            DrawText(g, Spaced(T.TabsEyebrow), fEyebrow, Accent, X0, 70);
            DrawText(g, T.TabsTitle, fTitle, TextMain, X0 - 3, 86);
            DrawWrapped(g, T.TabsText, fBody, TextBody, new RectangleF(X0, 140, CW - 10, 48));

            // Плитки 3×3
            const float gap = 8, tileH = 44;
            float tileW = (CW - gap * 2) / 3;
            for (int i = 0; i < AllTabs.Length; i++)
            {
                string tab = AllTabs[i];
                bool locked = LockedTabs.Contains(tab);
                bool on = tabs.Contains(tab);
                RectangleF tile = new RectangleF(X0 + (i % 3) * (tileW + gap), 206 + (i / 3) * (tileH + gap), tileW, tileH);
                string id = "tab:" + tab;
                if (!locked) Hit(id, tile);
                Color fill = on ? Color.FromArgb(locked ? 22 : 34, 229, 57, 53) : Panel;
                FillRound(g, tile, 11, fill);
                StrokeRound(g, tile, 11, on ? Color.FromArgb(locked ? 70 : 150, 229, 57, 53) : (hover == id ? StrokeHover : Stroke));
                DrawText(g, T.TabNames[tab], fBody, on ? TextMain : TextSub, tile.X + 12, tile.Y + (locked ? 6 : 12));
                if (locked) DrawText(g, T.Always, fSmall, TextSub, tile.X + 12, tile.Y + 23);
                RectangleF mark = new RectangleF(tile.Right - 28, tile.Y + 12, 18, 18);
                if (on)
                {
                    using (SolidBrush brush = new SolidBrush(locked ? Color.FromArgb(110, 229, 57, 53) : Accent)) g.FillEllipse(brush, mark);
                    DrawCentered(g, locked ? "" : "", fIconSmall, Color.White, mark);
                }
                else
                {
                    using (Pen pen = new Pen(hover == id ? StrokeHover : Color.FromArgb(70, 70, 78), 1.2f)) g.DrawEllipse(pen, mark);
                }
            }

            DrawPrimary(g, "tabsDone", T.TabsDone, new RectangleF(X0, 398, CW, 48));
        }

        private void DrawUninstallConfirm(Graphics g)
        {
            DrawText(g, Spaced(T.UEyebrow), fEyebrow, Accent, X0, 70);
            DrawText(g, T.UTitle, fTitle, TextMain, X0 - 3, 86);
            DrawWrapped(g, string.Format(T.UText, installDir), fBody, TextBody, new RectangleF(X0, 146, CW - 10, 64));
            if (canDeleteSettings) DrawCheckbox(g, "deleteSettings", deleteSettings, T.UDeleteSettings, 236);

            SizeF size = g.MeasureString(T.Cancel, fBody);
            RectangleF link = new RectangleF(X0 + (CW - size.Width) / 2 - 10, 352, size.Width + 20, 30);
            Hit("close", link);
            DrawCentered(g, T.Cancel, fBody, hover == "close" ? TextMain : TextSub, link);
            DrawPrimary(g, "uninstall", T.UButton, new RectangleF(X0, 398, CW, 48));
        }

        private void DrawProgress(Graphics g, string eyebrow, string title, string hint)
        {
            DrawText(g, Spaced(eyebrow), fEyebrow, Accent, X0, 78);
            DrawText(g, title, fTitle, TextMain, X0 - 3, 94);
            DrawText(g, status, fSub, TextSub, X0, 146);

            RectangleF track = new RectangleF(X0, 268, CW, 6);
            FillRound(g, track, 3, Panel);
            float value = Math.Max(0f, Math.Min(1f, progressShown));
            if (value > 0.002f)
            {
                RectangleF bar = new RectangleF(track.X, track.Y, Math.Max(6, track.Width * value), track.Height);
                FillRound(g, bar, 3, Accent);
                // Бегущий блик по полосе
                float t = (Environment.TickCount % 1600) / 1600f;
                RectangleF glow = new RectangleF(bar.X + (bar.Width + 80) * t - 80, bar.Y, 80, bar.Height);
                Region old = g.Clip;
                using (GraphicsPath clip = RoundPath(bar, 3))
                {
                    g.SetClip(clip, CombineMode.Intersect);
                    using (LinearGradientBrush shine = new LinearGradientBrush(new RectangleF(glow.X - 1, glow.Y, glow.Width + 2, glow.Height), Color.Transparent, Color.Transparent, LinearGradientMode.Horizontal))
                    {
                        ColorBlend blend = new ColorBlend(3);
                        blend.Colors = new[] { Color.FromArgb(0, 255, 255, 255), Color.FromArgb(110, 255, 255, 255), Color.FromArgb(0, 255, 255, 255) };
                        blend.Positions = new[] { 0f, 0.5f, 1f };
                        shine.InterpolationColors = blend;
                        g.FillRectangle(shine, glow);
                    }
                }
                g.Clip = old;
            }
            string percent = ((int)Math.Round(value * 100)).ToString() + "%";
            SizeF ps = g.MeasureString(percent, fSmall);
            DrawText(g, percent, fSmall, TextMain, X0 + CW - ps.Width + 4, 240);
            DrawText(g, hint, fSmall, TextSub, X0, 290);
        }

        private void DrawMessage(Graphics g, string title, string text, string kind, string primaryId, string primary, string secondaryId, string secondary)
        {
            Color tone = kind == "ok" ? Color.FromArgb(46, 204, 113) : (kind == "error" ? Accent : Color.FromArgb(245, 166, 35));
            RectangleF badge = new RectangleF(X0, 84, 52, 52);
            using (SolidBrush halo = new SolidBrush(Color.FromArgb(36, tone))) g.FillEllipse(halo, badge);
            string glyph = kind == "ok" ? "" : (kind == "error" ? "" : "");
            using (Font big = new Font("Segoe MDL2 Assets", 16f)) DrawCentered(g, glyph, big, tone, badge);

            DrawText(g, title, fTitle, TextMain, X0 - 3, 152);
            DrawWrapped(g, text, fBody, TextBody, new RectangleF(X0, 206, CW - 10, 64));

            DrawPrimary(g, primaryId, primary, new RectangleF(X0, 398, CW, 48));
            if (secondaryId == null) return;
            SizeF size = g.MeasureString(secondary, fBody);
            RectangleF link = new RectangleF(X0 + (CW - size.Width) / 2 - 10, 352, size.Width + 20, 30);
            Hit(secondaryId, link);
            DrawCentered(g, secondary, fBody, hover == secondaryId ? TextMain : TextSub, link);
        }

        // ---------- примитивы ----------
        private void Hit(string id, RectangleF rect) { hits[id] = rect; }

        private static string Spaced(string text)
        {
            return string.Join(" ", text.ToCharArray().Select(c => c.ToString()).ToArray());
        }

        private static void DrawText(Graphics g, string text, Font font, Color color, float x, float y)
        {
            using (SolidBrush brush = new SolidBrush(color)) g.DrawString(text, font, brush, x, y);
        }

        private static void DrawCentered(Graphics g, string text, Font font, Color color, RectangleF rect)
        {
            using (SolidBrush brush = new SolidBrush(color))
            using (StringFormat format = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center })
                g.DrawString(text, font, brush, rect, format);
        }

        private static void DrawWrapped(Graphics g, string text, Font font, Color color, RectangleF rect)
        {
            using (SolidBrush brush = new SolidBrush(color)) g.DrawString(text, font, brush, rect);
        }

        private static void DrawEllipsis(Graphics g, string text, Font font, Color color, RectangleF rect)
        {
            using (SolidBrush brush = new SolidBrush(color))
            using (StringFormat format = new StringFormat(StringFormatFlags.NoWrap) { LineAlignment = StringAlignment.Center, Trimming = StringTrimming.EllipsisCharacter })
                g.DrawString(text, font, brush, rect, format);
        }

        private static GraphicsPath RoundPath(RectangleF r, float radius)
        {
            float d = Math.Min(radius * 2, Math.Min(r.Width, r.Height));
            GraphicsPath path = new GraphicsPath();
            path.AddArc(r.X, r.Y, d, d, 180, 90);
            path.AddArc(r.Right - d, r.Y, d, d, 270, 90);
            path.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
            path.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
            path.CloseFigure();
            return path;
        }

        private static void FillRound(Graphics g, RectangleF r, float radius, Color color)
        {
            using (GraphicsPath path = RoundPath(r, radius))
            using (SolidBrush brush = new SolidBrush(color)) g.FillPath(brush, path);
        }

        private static void StrokeRound(Graphics g, RectangleF r, float radius, Color color)
        {
            using (GraphicsPath path = RoundPath(new RectangleF(r.X + 0.5f, r.Y + 0.5f, r.Width - 1, r.Height - 1), radius))
            using (Pen pen = new Pen(color, 1f)) g.DrawPath(pen, path);
        }

        // ---------- мышь и клавиатура ----------
        private string HitAt(Point location)
        {
            PointF p = new PointF(location.X / s, location.Y / s);
            foreach (KeyValuePair<string, RectangleF> pair in hits) if (pair.Value.Contains(p)) return pair.Key;
            return "";
        }

        protected override void OnMouseMove(MouseEventArgs e)
        {
            base.OnMouseMove(e);
            string id = HitAt(e.Location);
            if (id != hover)
            {
                hover = id;
                Cursor = id == "" ? Cursors.Default : Cursors.Hand;
                Invalidate();
            }
        }

        protected override void OnMouseLeave(EventArgs e)
        {
            base.OnMouseLeave(e);
            hover = ""; pressed = "";
            Invalidate();
        }

        protected override void OnMouseDown(MouseEventArgs e)
        {
            base.OnMouseDown(e);
            if (e.Button != MouseButtons.Left) return;
            string id = HitAt(e.Location);
            if (id == "")
            {
                ReleaseCapture();
                SendMessage(Handle, 0xA1, (IntPtr)2, IntPtr.Zero); // перетаскивание за пустое место
                return;
            }
            pressed = id;
            Invalidate();
        }

        protected override void OnMouseUp(MouseEventArgs e)
        {
            base.OnMouseUp(e);
            string id = HitAt(e.Location);
            string was = pressed;
            pressed = "";
            Invalidate();
            if (id != "" && id == was) Activate(id);
        }

        protected override void OnKeyDown(KeyEventArgs e)
        {
            base.OnKeyDown(e);
            if (e.KeyCode == Keys.Escape) Activate(screen == Screen.Tabs ? "tabsDone" : "x");
            if (e.KeyCode == Keys.Enter)
            {
                if (screen == Screen.Welcome) Activate("install");
                else if (screen == Screen.Tabs) Activate("tabsDone");
                else if (screen == Screen.Done) Activate("launch");
                else if (screen == Screen.UConfirm) Activate("uninstall");
                else if (screen == Screen.UDone) Activate("close");
            }
        }

        private void Activate(string id)
        {
            if (id.StartsWith("tab:"))
            {
                string tab = id.Substring(4);
                if (tabs.Contains(tab)) tabs.Remove(tab); else tabs.Add(tab);
                Invalidate();
                return;
            }
            switch (id)
            {
                case "min": WindowState = FormWindowState.Minimized; break;
                case "x":
                case "close":
                    if (!Busy) Close();
                    break;
                case "folder": PickFolder(); break;
                case "shortcut": desktopShortcut = !desktopShortcut; Invalidate(); break;
                case "deleteSettings": deleteSettings = !deleteSettings; Invalidate(); break;
                case "tabs": screen = Screen.Tabs; hover = ""; Invalidate(); break;
                case "tabsDone": screen = Screen.Welcome; hover = ""; Invalidate(); break;
                case "install":
                case "retry":
                    if (uninstallMode) StartUninstall(); else StartInstall();
                    break;
                case "uninstall": StartUninstall(); break;
                case "closeLauncher":
                    foreach (Process process in RunningInTarget())
                    {
                        try { process.Kill(); process.WaitForExit(5000); } catch { }
                    }
                    if (uninstallMode) StartUninstall(); else StartInstall();
                    break;
                case "launch":
                    try { Process.Start(new ProcessStartInfo(Path.Combine(installDir, "RxLauncher.exe")) { UseShellExecute = true, WorkingDirectory = installDir }); } catch { }
                    Close();
                    break;
            }
        }

        private void PickFolder()
        {
            string picked = FolderPicker.Pick(Handle, T.PickFolder, Directory.Exists(installDir) ? installDir : Path.GetDirectoryName(installDir));
            if (string.IsNullOrEmpty(picked)) return;
            // Выбрали общую папку — ставим во вложенную RxLauncher, а не прямо в неё
            if (!picked.TrimEnd('\\').EndsWith("RxLauncher", StringComparison.OrdinalIgnoreCase)) picked = Path.Combine(picked, "RxLauncher");
            installDir = picked;
            Invalidate();
        }

        // Мешает только лаунчер, запущенный из папки установки; копия в другом месте — нет
        private List<Process> RunningInTarget()
        {
            List<Process> result = new List<Process>();
            string target = Path.GetFullPath(installDir).TrimEnd('\\') + "\\";
            foreach (Process process in Process.GetProcessesByName("RxLauncher"))
            {
                try
                {
                    if (process.MainModule.FileName.StartsWith(target, StringComparison.OrdinalIgnoreCase)) result.Add(process);
                }
                catch
                {
                    result.Add(process); // путь не узнать — лучше перестраховаться
                }
            }
            return result;
        }

        private void SetProgress(float value, string text)
        {
            BeginInvoke((MethodInvoker)delegate
            {
                progressTarget = value;
                if (text != null) status = text;
            });
        }

        private void Fail(Exception error)
        {
            InstallException install = error as InstallException;
            errorCode = install != null ? install.Code : error.GetType().Name;
            BeginInvoke((MethodInvoker)delegate { screen = Screen.Error; Invalidate(); });
        }

        // ---------- установка ----------
        private void StartInstall()
        {
            if (RunningInTarget().Count > 0) { screen = Screen.Running; Invalidate(); return; }
            screen = Screen.Installing;
            status = T.Extracting;
            progressTarget = 0.02f;
            progressShown = 0;
            Invalidate();
            new Thread(InstallWorker) { IsBackground = true }.Start();
        }

        private void InstallWorker()
        {
            string payload = Path.Combine(Path.GetTempPath(), "RxLauncherSetup-" + Guid.NewGuid().ToString("N") + ".exe");
            try
            {
                // 1. Распаковываем встроенный NSIS-установщик (0–12%)
                using (Stream source = Assembly.GetExecutingAssembly().GetManifestResourceStream("payload.exe"))
                using (FileStream target = File.Create(payload))
                {
                    byte[] buffer = new byte[1 << 20];
                    long total = source.Length, done = 0;
                    int read;
                    while ((read = source.Read(buffer, 0, buffer.Length)) > 0)
                    {
                        target.Write(buffer, 0, read);
                        done += read;
                        SetProgress(0.12f * done / total, null);
                    }
                }

                // 2. Тихая установка (12–96%): оценка по времени + по объёму скопированного
                SetProgress(0.13f, T.Copying);
                long before = DirectorySize(installDir);
                bool sawCleanup = before < expectedBytes / 4; // при обновлении NSIS сначала удаляет старые файлы
                float part = 0f;
                Stopwatch clock = Stopwatch.StartNew();
                ProcessStartInfo info = new ProcessStartInfo(payload, "/S /currentuser /D=" + installDir) { UseShellExecute = false, CreateNoWindow = true };
                using (Process process = Process.Start(info))
                {
                    while (!process.WaitForExit(250))
                    {
                        float timePart = 0.85f * (1f - (float)Math.Exp(-clock.Elapsed.TotalSeconds / 14.0));
                        float sizePart = 0f;
                        if (expectedBytes > 0)
                        {
                            long size = DirectorySize(installDir);
                            if (size < before / 3) sawCleanup = true;
                            if (sawCleanup) sizePart = Math.Min(1f, (float)size / expectedBytes);
                        }
                        part = Math.Max(part, Math.Max(timePart, sizePart)); // полоса только растёт
                        SetProgress(0.13f + 0.83f * part, null);
                    }
                    exitCode = process.ExitCode;
                }
                if (exitCode != 0) throw new InstallException(exitCode.ToString());
                if (!File.Exists(Path.Combine(installDir, "RxLauncher.exe"))) throw new InstallException("no-exe");

                // 3. Ярлык и выбранные вкладки
                SetProgress(0.98f, T.Finishing);
                string shortcut = DesktopShortcutPath();
                if (!desktopShortcut && File.Exists(shortcut)) { try { File.Delete(shortcut); } catch { } }
                SaveTabsChoice();
                Thread.Sleep(300);
                SetProgress(1f, null);
                Thread.Sleep(450);
                BeginInvoke((MethodInvoker)delegate { screen = Screen.Done; Invalidate(); });
            }
            catch (Exception error)
            {
                Fail(error);
            }
            finally
            {
                try { if (File.Exists(payload)) File.Delete(payload); } catch { }
            }
        }

        // ---------- удаление ----------
        private void StartUninstall()
        {
            if (RunningInTarget().Count > 0) { screen = Screen.Running; Invalidate(); return; }
            screen = Screen.Uninstalling;
            status = T.URemoving;
            progressTarget = 0.04f;
            progressShown = 0;
            Invalidate();
            new Thread(UninstallWorker) { IsBackground = true }.Start();
        }

        private void UninstallWorker()
        {
            try
            {
                string uninstaller = Path.Combine(installDir, "Uninstall RxLauncher.exe");
                if (!File.Exists(uninstaller)) throw new InstallException("no-uninstaller");
                long before = Math.Max(1, DirectorySize(installDir));
                float part = 0f;
                Stopwatch clock = Stopwatch.StartNew();
                // _?= — NSIS работает на месте и ждёт завершения, а не перезапускается из временной папки
                ProcessStartInfo info = new ProcessStartInfo(uninstaller, "/S /currentuser _?=" + installDir) { UseShellExecute = false, CreateNoWindow = true };
                using (Process process = Process.Start(info))
                {
                    while (!process.WaitForExit(200))
                    {
                        float timePart = 0.8f * (1f - (float)Math.Exp(-clock.Elapsed.TotalSeconds / 5.0));
                        float sizePart = 1f - Math.Min(1f, (float)DirectorySize(installDir) / before);
                        part = Math.Max(part, Math.Max(timePart, sizePart));
                        SetProgress(0.04f + 0.86f * part, null);
                    }
                    exitCode = process.ExitCode;
                }
                if (exitCode != 0) throw new InstallException(exitCode.ToString());

                // Сам деинсталлятор NSIS с _?= остаётся в папке — убираем его и пустую папку
                try { File.Delete(uninstaller); } catch { }
                try
                {
                    if (Directory.Exists(installDir) && !Directory.EnumerateFiles(installDir, "*", SearchOption.AllDirectories).Any())
                        Directory.Delete(installDir, true);
                }
                catch { }

                SetProgress(0.95f, null);
                if (deleteSettings && canDeleteSettings)
                {
                    try { Directory.Delete(UserDataDir(), true); } catch { }
                }
                SetProgress(1f, null);
                Thread.Sleep(450);
                BeginInvoke((MethodInvoker)delegate { screen = Screen.UDone; Invalidate(); });
            }
            catch (Exception error)
            {
                Fail(error);
            }
        }

        private static long DirectorySize(string path)
        {
            try
            {
                if (!Directory.Exists(path)) return 0;
                long total = 0;
                foreach (string file in Directory.EnumerateFiles(path, "*", SearchOption.AllDirectories))
                {
                    try { total += new FileInfo(file).Length; } catch { }
                }
                return total;
            }
            catch { return 0; }
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            if (Busy && e.CloseReason == CloseReason.UserClosing)
            {
                e.Cancel = true;
                return;
            }
            base.OnFormClosing(e);
        }

        // Для автотестов: --auto=install|uninstall нажимает основную кнопку сам и закрывает окно после «Готово»
        protected override void OnShown(EventArgs e)
        {
            base.OnShown(e);
            string auto = ArgValue("--auto");
            if (auto == null) return;
            System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer { Interval = 700 };
            bool started = false;
            int waitAfterDone = 0;
            timer.Tick += delegate
            {
                if (!started) { started = true; Activate(auto == "uninstall" ? "uninstall" : "install"); return; }
                if (screen == Screen.Done || screen == Screen.UDone || screen == Screen.Error || screen == Screen.Running)
                {
                    if (++waitAfterDone >= 3) { timer.Stop(); Close(); }
                }
            };
            timer.Start();
        }

        protected override void OnFormClosed(FormClosedEventArgs e)
        {
            base.OnFormClosed(e);
            // Временная копия деинсталлятора удаляет себя после закрытия
            string self = Assembly.GetExecutingAssembly().Location;
            if (uninstallMode && self.StartsWith(Path.GetFullPath(Path.GetTempPath()), StringComparison.OrdinalIgnoreCase))
            {
                try
                {
                    Process.Start(new ProcessStartInfo("cmd.exe", "/c ping 127.0.0.1 -n 3 > nul & del /f /q \"" + self + "\"")
                    {
                        CreateNoWindow = true, UseShellExecute = false, WindowStyle = ProcessWindowStyle.Hidden
                    });
                }
                catch { }
            }
        }
    }

    internal sealed class InstallException : Exception
    {
        public readonly string Code;
        public InstallException(string code) : base(code) { Code = code; }
    }

    // Современный выбор папки (IFileOpenDialog с FOS_PICKFOLDERS)
    internal static class FolderPicker
    {
        [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")] private class FileOpenDialogRCW { }

        [ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface IFileOpenDialog
        {
            [PreserveSig] int Show(IntPtr parent);
            void SetFileTypes(); void SetFileTypeIndex(); void GetFileTypeIndex(); void Advise(); void Unadvise();
            void SetOptions(uint fos); void GetOptions(out uint fos);
            void SetDefaultFolder(IShellItem item); void SetFolder(IShellItem item);
            void GetFolder(); void GetCurrentSelection();
            void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name); void GetFileName();
            void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
            void SetOkButtonLabel(); void SetFileNameLabel();
            void GetResult(out IShellItem item);
        }

        [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface IShellItem
        {
            void BindToHandler(); void GetParent();
            void GetDisplayName(uint sigdn, [MarshalAs(UnmanagedType.LPWStr)] out string name);
            void GetAttributes(); void Compare();
        }

        [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
        private static extern void SHCreateItemFromParsingName(string path, IntPtr bindCtx, [MarshalAs(UnmanagedType.LPStruct)] Guid riid, out IShellItem item);

        public static string Pick(IntPtr owner, string title, string start)
        {
            try
            {
                IFileOpenDialog dialog = (IFileOpenDialog)new FileOpenDialogRCW();
                dialog.SetOptions(0x20 | 0x40 | 0x800); // PICKFOLDERS | FORCEFILESYSTEM | PATHMUSTEXIST
                dialog.SetTitle(title);
                if (!string.IsNullOrEmpty(start) && Directory.Exists(start))
                {
                    IShellItem folder;
                    SHCreateItemFromParsingName(start, IntPtr.Zero, typeof(IShellItem).GUID, out folder);
                    dialog.SetFolder(folder);
                }
                if (dialog.Show(owner) != 0) return null;
                IShellItem result;
                dialog.GetResult(out result);
                string path;
                result.GetDisplayName(0x80058000, out path); // SIGDN_FILESYSPATH
                return path;
            }
            catch
            {
                using (FolderBrowserDialog fallback = new FolderBrowserDialog { Description = title, SelectedPath = start ?? "" })
                    return fallback.ShowDialog() == DialogResult.OK ? fallback.SelectedPath : null;
            }
        }
    }
}
