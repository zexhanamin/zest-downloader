# yt-dlp bridge: reflected and JNI-loaded, keep it whole
-keep class com.yausername.** { *; }
-keep class org.apache.commons.compress.archivers.zip.** { *; }
-dontwarn org.apache.commons.compress.**

# Jackson (used by the yt-dlp bridge to parse its JSON)
-keep class com.fasterxml.jackson.** { *; }
-keepnames class com.fasterxml.jackson.** { *; }
-dontwarn com.fasterxml.jackson.databind.**

# kotlinx.serialization
-keepattributes *Annotation*, InnerClasses
-keepclassmembers class app.zest.downloader.data.** { *** Companion; *; }
-keep,includedescriptorclasses class app.zest.downloader.**$$serializer { *; }

# The in-browser bridge is called from JavaScript by name
-keepclassmembers class app.zest.downloader.ui.ZestJsBridge { @android.webkit.JavascriptInterface <methods>; }

-dontwarn okhttp3.internal.platform.**
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**
