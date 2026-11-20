package dev.pichat

import android.content.Context
import android.content.Intent
import android.net.Uri
import io.noties.markwon.AbstractMarkwonPlugin
import io.noties.markwon.Markwon
import io.noties.markwon.MarkwonConfiguration
import io.noties.markwon.SoftBreakAddsNewLinePlugin
import io.noties.markwon.core.MarkwonTheme
import io.noties.markwon.ext.strikethrough.StrikethroughPlugin
import io.noties.markwon.ext.tables.TablePlugin

fun chatMarkdown(context: Context): Markwon = Markwon.builder(context)
    .usePlugin(SoftBreakAddsNewLinePlugin.create())
    .usePlugin(StrikethroughPlugin.create())
    .usePlugin(TablePlugin.create(context))
    .usePlugin(object : AbstractMarkwonPlugin() {
        override fun configureParser(builder: org.commonmark.parser.Parser.Builder) {
            builder.inlineParserFactory(::cjkInlineParser)
        }

        override fun configureTheme(builder: MarkwonTheme.Builder) {
            builder.headingTextSizeMultipliers(floatArrayOf(1.45f, 1.28f, 1.12f, 1.12f, 1.12f, 1.12f))
                .headingBreakHeight(0)
        }

        override fun configureConfiguration(builder: MarkwonConfiguration.Builder) {
            builder.linkResolver { view, destination ->
                val uri = Uri.parse(destination)
                if (uri.scheme?.lowercase() in setOf("http", "https") && !uri.host.isNullOrBlank()) {
                    try {
                        view.context.startActivity(Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE))
                    } catch (_: android.content.ActivityNotFoundException) {
                        android.widget.Toast.makeText(view.context, "没有可打开链接的浏览器", android.widget.Toast.LENGTH_SHORT).show()
                    }
                }
            }
        }
    }).build()
