package org.libreoffice.kit;

import java.nio.ByteBuffer;

public final class Office {
    // The native interface looks up this field by name and signature.
    private final ByteBuffer handle;
    public Office(ByteBuffer handle) { this.handle = handle; }
    public native ByteBuffer documentLoadNative(String path);
}
