import AVFoundation
import WebKit

/// iOS counterpart of MicBridge.kt. NOT YET TESTED ON A DEVICE.
///
/// Records the microphone with AVAudioEngine, converts it to 16 kHz mono 16-bit PCM and hands it to
/// the page as window.freyaMic.onFrame(base64), then window.freyaMic.onEnd() after stop.
/// The page sends { command: "start" } and { command: "stop" } to the "FreyaMicNative" handler.
///
/// Register once:
///   let bridge = MicBridge(webView: webView)
///   webView.configuration.userContentController.add(bridge, name: "FreyaMicNative")
/// Info.plist needs NSMicrophoneUsageDescription.
final class MicBridge: NSObject, WKScriptMessageHandler {
    private weak var webView: WKWebView?
    private let engine = AVAudioEngine()
    private let target = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16000, channels: 1, interleaved: true)!
    private var running = false

    init(webView: WKWebView) {
        self.webView = webView
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let command = body["command"] as? String else { return }
        if command == "start" { start() } else if command == "stop" { stop() }
    }

    private func start() {
        if running { return }
        AVAudioSession.sharedInstance().requestRecordPermission { [weak self] granted in
            DispatchQueue.main.async { granted ? self?.record() : self?.finish() }
        }
    }

    private func record() {
        let session = AVAudioSession.sharedInstance()
        do {
            // .playAndRecord keeps text to speech audible; .measurement turns off voice processing
            try session.setCategory(.playAndRecord, mode: .measurement, options: [.defaultToSpeaker, .allowBluetooth])
            try session.setActive(true)
        } catch {
            finish()
            return
        }
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard let converter = AVAudioConverter(from: format, to: target) else { finish(); return }
        input.installTap(onBus: 0, bufferSize: 4096, format: format) { [weak self] buffer, _ in
            guard let self = self else { return }
            let capacity = AVAudioFrameCount(Double(buffer.frameLength) * 16000 / format.sampleRate) + 16
            guard let out = AVAudioPCMBuffer(pcmFormat: self.target, frameCapacity: capacity) else { return }
            var supplied = false
            var error: NSError?
            converter.convert(to: out, error: &error) { _, status in
                if supplied { status.pointee = .noDataNow; return nil }
                supplied = true
                status.pointee = .haveData
                return buffer
            }
            guard error == nil, out.frameLength > 0, let samples = out.int16ChannelData else { return }
            let data = Data(bytes: samples[0], count: Int(out.frameLength) * 2) // little-endian on iOS
            let frame = data.base64EncodedString()
            DispatchQueue.main.async {
                self.webView?.evaluateJavaScript("window.freyaMic && window.freyaMic.onFrame('\(frame)')", completionHandler: nil)
            }
        }
        do {
            try engine.start()
            running = true
        } catch {
            input.removeTap(onBus: 0)
            finish()
        }
    }

    private func stop() {
        if running {
            engine.stop()
            engine.inputNode.removeTap(onBus: 0)
            running = false
        }
        finish()
    }

    private func finish() {
        webView?.evaluateJavaScript("window.freyaMic && window.freyaMic.onEnd()", completionHandler: nil)
    }
}
