package org.libreoffice.kit;

import java.nio.ByteBuffer;

public final class Document {
    private final ByteBuffer handle;
    public Document(ByteBuffer handle) { this.handle = handle; }
    public native void initializeForRendering();
    public native int getDocumentTypeNative();
    public native int getParts();
    public native String getPartName(int index);
    public native void setPart(int index);
    public native long getDocumentWidth();
    public native long getDocumentHeight();
    public native String getPartPageRectangles();
    public native void paintTileNative(ByteBuffer pixels, int width, int height,
        int left, int top, int documentWidth, int documentHeight);
    public native void destroy();
}
