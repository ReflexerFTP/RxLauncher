package xyz.rxlauncher.capes.iso;

import java.lang.instrument.ClassFileTransformer;
import java.security.ProtectionDomain;

import org.objectweb.asm.ClassReader;
import org.objectweb.asm.ClassVisitor;
import org.objectweb.asm.ClassWriter;
import org.objectweb.asm.MethodVisitor;
import org.objectweb.asm.Opcodes;

/**
 * Перед каждым return в трёх методах сессии authlib вставляет вызов Bridge:
 * результат = Bridge.HOOK.apply(результат, первый аргумент).
 * Имена authlib не обфусцированы и одинаковы во всех версиях игры и загрузчиках.
 * Вставка без ветвлений: таблицы фреймов остаются верными, пересчитывается только глубина стека.
 */
final class AuthlibTransformer implements ClassFileTransformer {
    static final String TARGET = "com/mojang/authlib/yggdrasil/YggdrasilMinecraftSessionService";
    private static final String BRIDGE = "xyz.rxlauncher.capes.Bridge";

    @Override
    public byte[] transform(ClassLoader loader, String className, Class<?> redefined, ProtectionDomain domain, byte[] bytes) {
        if (!TARGET.equals(className) || redefined != null) return null;
        try {
            return patch(bytes);
        } catch (Throwable error) {
            System.err.println("[RxCapes] Could not patch authlib: " + error);
            return null;
        }
    }

    static byte[] patch(byte[] bytes) {
        ClassReader reader = new ClassReader(bytes);
        ClassWriter writer = new ClassWriter(reader, ClassWriter.COMPUTE_MAXS);
        int[] patched = {0};
        reader.accept(new ClassVisitor(Opcodes.ASM9, writer) {
            @Override
            public MethodVisitor visitMethod(int access, String name, String descriptor, String signature, String[] exceptions) {
                MethodVisitor next = super.visitMethod(access, name, descriptor, signature, exceptions);
                String field = hookFor(access, name, descriptor);
                if (field == null) return next;
                patched[0]++;
                String returnType = descriptor.substring(descriptor.indexOf(')') + 2, descriptor.length() - 1);
                return new MethodVisitor(Opcodes.ASM9, next) {
                    @Override
                    public void visitInsn(int opcode) {
                        if (opcode == Opcodes.ARETURN) {
                            // стек: результат
                            super.visitLdcInsn(BRIDGE);
                            super.visitInsn(Opcodes.ICONST_1);
                            super.visitMethodInsn(Opcodes.INVOKESTATIC, "java/lang/ClassLoader", "getSystemClassLoader", "()Ljava/lang/ClassLoader;", false);
                            super.visitMethodInsn(Opcodes.INVOKESTATIC, "java/lang/Class", "forName", "(Ljava/lang/String;ZLjava/lang/ClassLoader;)Ljava/lang/Class;", false);
                            super.visitLdcInsn(field);
                            super.visitMethodInsn(Opcodes.INVOKEVIRTUAL, "java/lang/Class", "getField", "(Ljava/lang/String;)Ljava/lang/reflect/Field;", false);
                            super.visitInsn(Opcodes.ACONST_NULL);
                            super.visitMethodInsn(Opcodes.INVOKEVIRTUAL, "java/lang/reflect/Field", "get", "(Ljava/lang/Object;)Ljava/lang/Object;", false);
                            super.visitTypeInsn(Opcodes.CHECKCAST, "java/util/function/BiFunction");
                            // стек: результат, функция → функция, результат, аргумент
                            super.visitInsn(Opcodes.SWAP);
                            super.visitVarInsn(Opcodes.ALOAD, 1);
                            super.visitMethodInsn(Opcodes.INVOKEINTERFACE, "java/util/function/BiFunction", "apply", "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;", true);
                            super.visitTypeInsn(Opcodes.CHECKCAST, returnType);
                        }
                        super.visitInsn(opcode);
                    }
                };
            }
        }, 0);
        if (patched[0] == 0) return null;
        System.out.println("[RxCapes] Patched authlib session service (" + patched[0] + " methods)");
        return writer.toByteArray();
    }

    static String hookFor(int access, String name, String descriptor) {
        if ((access & (Opcodes.ACC_STATIC | Opcodes.ACC_ABSTRACT | Opcodes.ACC_BRIDGE | Opcodes.ACC_SYNTHETIC)) != 0) return null;
        if ("getPackedTextures".equals(name) && "(Lcom/mojang/authlib/GameProfile;)Lcom/mojang/authlib/properties/Property;".equals(descriptor)) return "PACKED";
        if ("unpackTextures".equals(name) && "(Lcom/mojang/authlib/properties/Property;)Lcom/mojang/authlib/minecraft/MinecraftProfileTextures;".equals(descriptor)) return "UNPACK";
        if ("getTextures".equals(name) && "(Lcom/mojang/authlib/GameProfile;Z)Ljava/util/Map;".equals(descriptor)) return "TEXTURES";
        return null;
    }
}
