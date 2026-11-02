package com.example.freya

import android.Manifest
import android.annotation.SuppressLint
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.util.Base64
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.core.content.ContextCompat
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * Records the microphone in the app and hands it to the page in the WebView as 16 kHz mono
 * 16-bit PCM, one 50 ms frame at a time: window.freyaMic.onFrame(base64), then
 * window.freyaMic.onEnd() after stop(). The page needs no microphone permission and no https.
 *
 * Register it once: webView.addJavascriptInterface(MicBridge(webView), "FreyaMicNative")
 * Ask for RECORD_AUDIO at runtime before the first start(); start() returns false without it.
 */
class MicBridge(private val webView: WebView) {
    private val rate = 16000
    private val frameSamples = rate / 20 // 50 ms
    @Volatile private var running = false

    @JavascriptInterface
    fun start(): Boolean {
        val granted = ContextCompat.checkSelfPermission(webView.context, Manifest.permission.RECORD_AUDIO)
        if (granted != PackageManager.PERMISSION_GRANTED) return false
        if (running) return true
        running = true
        Thread { record() }.start()
        return true
    }

    @JavascriptInterface
    fun stop() {
        running = false
    }

    @SuppressLint("MissingPermission") // checked in start()
    private fun record() {
        val min = AudioRecord.getMinBufferSize(rate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        val recorder = AudioRecord(
            MediaRecorder.AudioSource.VOICE_RECOGNITION, rate,
            AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT,
            maxOf(min, frameSamples * 2 * 4),
        )
        val samples = ShortArray(frameSamples)
        val bytes = ByteBuffer.allocate(frameSamples * 2).order(ByteOrder.LITTLE_ENDIAN)
        try {
            recorder.startRecording()
            while (running) {
                val n = recorder.read(samples, 0, frameSamples)
                if (n < 0) break
                if (n == 0) continue
                bytes.clear()
                bytes.asShortBuffer().put(samples, 0, n)
                val frame = Base64.encodeToString(bytes.array(), 0, n * 2, Base64.NO_WRAP)
                webView.post { webView.evaluateJavascript("window.freyaMic && window.freyaMic.onFrame('$frame')", null) }
            }
        } finally {
            running = false
            recorder.release()
            webView.post { webView.evaluateJavascript("window.freyaMic && window.freyaMic.onEnd()", null) }
        }
    }
}
