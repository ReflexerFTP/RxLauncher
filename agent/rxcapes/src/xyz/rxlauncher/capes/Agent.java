package xyz.rxlauncher.capes;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.lang.instrument.Instrumentation;
import java.util.function.BiFunction;
import java.util.jar.JarFile;
import java.util.zip.ZipEntry;

/**
 * Плащи RxLauncher: java-агент, который лаунчер подключает к любой версии игры.
 * ASM и вся логика лежат в jar под префиксом rxiso/ и грузятся отдельным загрузчиком,
 * чтобы не столкнуться с ASM самой игры (Fabric, Forge).
 */
public final class Agent {
    private Agent() {
    }

    public static void premain(String args, Instrumentation instrumentation) {
        try {
            File jar = new File(Agent.class.getProtectionDomain().getCodeSource().getLocation().toURI());
            ClassLoader isolated = new IsolatedLoader(new JarFile(jar));
            Class<?> boot = Class.forName("xyz.rxlauncher.capes.iso.Bootstrap", true, isolated);
            Object[] hooks = (Object[]) boot.getMethod("install", String.class, Instrumentation.class).invoke(null, args, instrumentation);
            Bridge.PACKED = cast(hooks[0]);
            Bridge.UNPACK = cast(hooks[1]);
            Bridge.TEXTURES = cast(hooks[2]);
        } catch (Throwable error) {
            System.err.println("[RxCapes] Disabled: " + error);
        }
    }

    @SuppressWarnings("unchecked")
    private static BiFunction<Object, Object, Object> cast(Object hook) {
        return (BiFunction<Object, Object, Object>) hook;
    }

    /** Классы из rxiso/ внутри агента; родитель — загрузчик JDK, игра и её библиотеки не видны. */
    static final class IsolatedLoader extends ClassLoader {
        private final JarFile jar;

        IsolatedLoader(JarFile jar) {
            super(null);
            this.jar = jar;
        }

        @Override
        protected Class<?> findClass(String name) throws ClassNotFoundException {
            ZipEntry entry = jar.getEntry("rxiso/" + name.replace('.', '/') + ".class");
            if (entry == null) throw new ClassNotFoundException(name);
            try (InputStream input = jar.getInputStream(entry)) {
                ByteArrayOutputStream output = new ByteArrayOutputStream();
                byte[] buffer = new byte[8192];
                int count;
                while ((count = input.read(buffer)) > 0) output.write(buffer, 0, count);
                byte[] bytes = output.toByteArray();
                return defineClass(name, bytes, 0, bytes.length);
            } catch (IOException error) {
                throw new ClassNotFoundException(name, error);
            }
        }
    }
}
