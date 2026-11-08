package xyz.rxlauncher.capes.iso;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.lang.reflect.Constructor;
import java.lang.reflect.Method;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Плащ по нику игрока: спрашивает API лаунчера и подставляет текстуру в ответ authlib.
 * Ошибки никогда не выходят наружу — в худшем случае игрок остаётся без плаща.
 */
final class CapeService {
    private static final Pattern NICK = Pattern.compile("[A-Za-z0-9_]{1,16}");
    private static final Pattern PROFILE_NAME = Pattern.compile("\"profileName\"\\s*:\\s*\"([^\"]{1,32})\"");
    private static final Pattern URL_FIELD = Pattern.compile("\"url\"\\s*:\\s*\"([^\"]{1,300})\"");
    private static final long FOUND_MS = 10 * 60_000L;
    private static final long MISSING_MS = 5 * 60_000L;
    private static final long ERROR_MS = 60_000L;
    private static final long WAIT_MS = 3_000L;

    private final String base;
    private final Map<String, Cached> cache = new ConcurrentHashMap<>();
    private final Map<String, CompletableFuture<String>> pending = new ConcurrentHashMap<>();
    private final ExecutorService executor = Executors.newFixedThreadPool(3, runnable -> {
        Thread thread = new Thread(runnable, "RxCapes lookup");
        thread.setDaemon(true);
        return thread;
    });
    private volatile long lastError;

    CapeService(String base) {
        this.base = base;
    }

    // ---------- хуки ----------

    /** Профиль без текстур (пиратский ник): отдаём пустой пакет с ником, чтобы игра дошла до unpackTextures. */
    Object packed(Object result, Object profile) {
        if (result != null || profile == null) return result;
        try {
            String name = profileName(profile);
            if (name == null) return null;
            prefetch(name);
            Object id = call(profile, "getId", "id");
            String json = "{\"timestamp\":0,\"profileId\":\"" + (id instanceof UUID ? id.toString().replace("-", "") : "") + "\",\"profileName\":\"" + name + "\",\"textures\":{}}";
            Class<?> property = Class.forName("com.mojang.authlib.properties.Property", true, profile.getClass().getClassLoader());
            return property.getConstructor(String.class, String.class)
                    .newInstance("textures", Base64.getEncoder().encodeToString(json.getBytes(StandardCharsets.UTF_8)));
        } catch (Throwable error) {
            report(error);
            return null;
        }
    }

    /** authlib 5+: добавляем плащ к уже распакованным текстурам. */
    Object unpack(Object result, Object property) {
        if (result == null || property == null) return result;
        try {
            Object value = call(property, "value", "getValue");
            String name = value instanceof String ? nameFromPayload((String) value) : null;
            String url = name == null ? null : capeFor(name);
            if (url == null) return result;
            ClassLoader loader = result.getClass().getClassLoader();
            Object cape = texture(loader, url);
            Object skin = call(result, "skin");
            Object elytra = call(result, "elytra");
            Class<?> stateType = Class.forName("com.mojang.authlib.SignatureState", true, loader);
            Object state = call(result, "signatureState");
            @SuppressWarnings({"unchecked", "rawtypes"})
            Object signed = Enum.valueOf((Class) stateType, "SIGNED");
            // Неподписанный скин чужого игрока игра всё равно не показывает — убираем его, а плащ помечаем
            // подписанным, иначе игра заменит весь набор текстур стандартным
            if (state != signed) skin = null;
            for (Constructor<?> constructor : result.getClass().getConstructors()) {
                if (constructor.getParameterCount() == 4) return constructor.newInstance(skin, cape, elytra, signed);
            }
        } catch (Throwable error) {
            report(error);
        }
        return result;
    }

    /** authlib до 4 включительно (игра 1.20.1 и старше): Map<Type, MinecraftProfileTexture>. */
    Object textures(Object result, Object profile) {
        if (!(result instanceof Map) || profile == null) return result;
        try {
            String name = profileName(profile);
            String url = name == null ? null : capeFor(name);
            if (url == null) return result;
            ClassLoader loader = profile.getClass().getClassLoader();
            Class<?> type = Class.forName("com.mojang.authlib.minecraft.MinecraftProfileTexture$Type", true, loader);
            @SuppressWarnings({"unchecked", "rawtypes"})
            Object capeType = Enum.valueOf((Class) type, "CAPE");
            @SuppressWarnings("unchecked")
            Map<Object, Object> copy = new HashMap<>((Map<Object, Object>) result);
            copy.put(capeType, texture(loader, url));
            return copy;
        } catch (Throwable error) {
            report(error);
            return result;
        }
    }

    // ---------- поиск плаща ----------

    /** URL текстуры или null. В потоке отрисовки не ждём сеть: там только кэш, запрос уходит в фон. */
    String capeFor(String name) {
        String key = name.toLowerCase();
        Cached cached = cache.get(key);
        if (cached != null && cached.expires > System.currentTimeMillis()) return cached.url;
        CompletableFuture<String> future = prefetch(name);
        if (future == null || isFrameThread()) return cached == null ? null : cached.url;
        try {
            return future.get(WAIT_MS, TimeUnit.MILLISECONDS);
        } catch (Throwable error) {
            return null;
        }
    }

    CompletableFuture<String> prefetch(String name) {
        if (!NICK.matcher(name).matches()) return null;
        String key = name.toLowerCase();
        Cached cached = cache.get(key);
        if (cached != null && cached.expires > System.currentTimeMillis()) return CompletableFuture.completedFuture(cached.url);
        CompletableFuture<String> future = pending.computeIfAbsent(key, k -> CompletableFuture.supplyAsync(() -> {
            Cached result = fetch(k);
            cache.put(k, result);
            return result.url;
        }, executor));
        future.whenComplete((url, error) -> pending.remove(key, future));
        return future;
    }

    private Cached fetch(String key) {
        long now = System.currentTimeMillis();
        try {
            HttpURLConnection connection = (HttpURLConnection) new URL(base + "/capes/n/" + key).openConnection();
            connection.setConnectTimeout(4000);
            connection.setReadTimeout(4000);
            connection.setInstanceFollowRedirects(false);
            connection.setRequestProperty("User-Agent", "RxCapes/1.0");
            connection.setRequestProperty("Accept", "application/json");
            int status = connection.getResponseCode();
            if (status == 404) return new Cached(null, now + MISSING_MS);
            if (status != 200) return new Cached(null, now + ERROR_MS);
            String body;
            try (InputStream input = connection.getInputStream()) {
                body = readLimited(input, 4096);
            }
            Matcher matcher = URL_FIELD.matcher(body);
            if (!matcher.find()) return new Cached(null, now + ERROR_MS);
            String url = matcher.group(1);
            // Текстуры — только с нашего сервера (адрес base уже проверен при запуске)
            if (!url.startsWith(base + "/capes/t/") || !url.matches("https?://[^\\s\"\\\\]+\\.png")) return new Cached(null, now + ERROR_MS);
            return new Cached(url, now + FOUND_MS);
        } catch (Throwable error) {
            report(error);
            return new Cached(null, now + ERROR_MS);
        }
    }

    // ---------- вспомогательное ----------

    private static boolean isFrameThread() {
        String name = Thread.currentThread().getName();
        return "Render thread".equals(name) || "Client thread".equals(name) || "Server thread".equals(name) || "main".equals(name);
    }

    private static String profileName(Object profile) throws Exception {
        Object name = call(profile, "getName", "name");
        return name instanceof String && NICK.matcher((String) name).matches() ? (String) name : null;
    }

    private static String nameFromPayload(String value) {
        try {
            String json = new String(Base64.getDecoder().decode(value.trim()), StandardCharsets.UTF_8);
            Matcher matcher = PROFILE_NAME.matcher(json);
            if (!matcher.find()) return null;
            String name = matcher.group(1);
            return NICK.matcher(name).matches() ? name : null;
        } catch (IllegalArgumentException error) {
            return null;
        }
    }

    private static Object texture(ClassLoader loader, String url) throws Exception {
        Class<?> type = Class.forName("com.mojang.authlib.minecraft.MinecraftProfileTexture", true, loader);
        return type.getConstructor(String.class, Map.class).newInstance(url, new HashMap<String, String>());
    }

    /** Первый существующий метод без аргументов: у authlib 4 — getName(), у record-ов authlib 7 — name(). */
    private static Object call(Object target, String... names) throws Exception {
        for (String name : names) {
            Method method;
            try {
                method = target.getClass().getMethod(name);
            } catch (NoSuchMethodException missing) {
                continue;
            }
            return method.invoke(target);
        }
        throw new NoSuchMethodException(target.getClass().getName() + "." + names[0]);
    }

    private static String readLimited(InputStream input, int limit) throws Exception {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] buffer = new byte[1024];
        int count;
        while ((count = input.read(buffer)) > 0) {
            output.write(buffer, 0, count);
            if (output.size() > limit) throw new IllegalStateException("Response too large");
        }
        return new String(output.toByteArray(), StandardCharsets.UTF_8);
    }

    private void report(Throwable error) {
        long now = System.currentTimeMillis();
        if (now - lastError < 60_000L) return;
        lastError = now;
        System.err.println("[RxCapes] " + error);
    }

    private static final class Cached {
        final String url;
        final long expires;

        Cached(String url, long expires) {
            this.url = url;
            this.expires = expires;
        }
    }
}
