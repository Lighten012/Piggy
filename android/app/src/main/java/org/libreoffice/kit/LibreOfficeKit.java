package org.libreoffice.kit;

import android.content.res.AssetManager;
import java.nio.ByteBuffer;

/** JNI entry points exported by the pinned Android LibreOfficeKit build. */
public final class LibreOfficeKit {
    private LibreOfficeKit() {}
    public static native boolean initializeNative(String data, String cache, String apk, AssetManager assets);
    public static native ByteBuffer getLibreOfficeKitHandle();
    public static native void putenv(String value);
}
