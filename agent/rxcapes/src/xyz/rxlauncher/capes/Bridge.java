package xyz.rxlauncher.capes;

import java.util.function.BiFunction;

/**
 * Точка входа для кода, вставленного в authlib. Он находит этот класс через системный загрузчик
 * (там лежит агент) и вызывает функции — так вставка работает и в Fabric, и в Forge, и в vanilla.
 */
public final class Bridge {
    /** getPackedTextures(GameProfile) → Property */
    public static volatile BiFunction<Object, Object, Object> PACKED = (result, profile) -> result;
    /** unpackTextures(Property) → MinecraftProfileTextures (authlib 5+) */
    public static volatile BiFunction<Object, Object, Object> UNPACK = (result, property) -> result;
    /** getTextures(GameProfile, boolean) → Map (authlib до 4 включительно) */
    public static volatile BiFunction<Object, Object, Object> TEXTURES = (result, profile) -> result;

    private Bridge() {
    }
}
