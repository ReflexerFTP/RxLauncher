package xyz.rxlauncher.capes.iso;

import java.lang.instrument.Instrumentation;
import java.util.function.BiFunction;

public final class Bootstrap {
    private Bootstrap() {
    }

    /** Возвращает функции для Bridge: PACKED, UNPACK, TEXTURES. */
    public static Object[] install(String args, Instrumentation instrumentation) {
        String base = args == null ? "" : args.trim();
        // http — только для локальной проверки (API на этом же компьютере)
        if (!base.matches("https://[A-Za-z0-9.-]+(:\\d{1,5})?") && !base.matches("http://127\\.0\\.0\\.1:\\d{1,5}")) {
            throw new IllegalArgumentException("Bad API address: " + base);
        }
        CapeService service = new CapeService(base);
        instrumentation.addTransformer(new AuthlibTransformer(), false);
        System.out.println("[RxCapes] Ready: " + base);
        BiFunction<Object, Object, Object> packed = service::packed;
        BiFunction<Object, Object, Object> unpack = service::unpack;
        BiFunction<Object, Object, Object> textures = service::textures;
        return new Object[]{packed, unpack, textures};
    }
}
