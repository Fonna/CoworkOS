import AVFoundation
import Darwin
import Foundation
import Speech

// A single, user-initiated dictation session. Audio is never written to disk.
// Keep status separate from capture: inspecting permissions must not prompt.
private struct Options {
    let status: Bool
    let locale: String

    static func parse(_ arguments: [String]) throws -> Options {
        var status: Bool?
        var locale = "zh-CN"
        var sawLocale = false
        var index = 0
        while index < arguments.count {
            switch arguments[index] {
            case "--status", "--listen":
                guard status == nil else { throw SpeechFailure.arguments }
                status = arguments[index] == "--status"
            case "--locale":
                guard !sawLocale, index + 1 < arguments.count else {
                    throw SpeechFailure.arguments
                }
                index += 1
                locale = arguments[index]
                sawLocale = true
            default:
                throw SpeechFailure.arguments
            }
            index += 1
        }
        guard let status, locale.utf8.count <= 35,
              locale.range(of: "\\A[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}\\z",
                           options: .regularExpression) != nil else {
            throw SpeechFailure.arguments
        }
        return Options(status: status, locale: locale)
    }
}

private struct SpeechFailure: Error {
    let code: String
    let message: String
    let native: NSError?

    init(_ code: String, _ message: String, native: NSError? = nil) {
        self.code = code
        self.message = message
        self.native = native
    }

    static let arguments = SpeechFailure(
        "invalid_arguments", "使用 --status 或 --listen，并通过 --locale 指定有效语言，例如 zh-CN。"
    )

    var event: [String: Any] {
        var value: [String: Any] = ["type": "error", "code": code, "message": message]
        if let native {
            // Native error descriptions may contain provider data; expose only codes.
            value["nativeDomain"] = native.domain
            value["nativeCode"] = native.code
        }
        return value
    }
}

private func emit(_ value: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) else {
        return
    }
    var line = data
    line.append(0x0a)
    try? FileHandle.standardOutput.write(contentsOf: line)
}

private func localeKey(_ identifier: String) -> String {
    identifier.replacingOccurrences(of: "_", with: "-").lowercased()
}

private enum SpeechEvent {
    static func started(locale: Locale, local: Bool) -> [String: Any] {
        ["type": "started", "locale": localeKey(locale.identifier),
         "mode": local ? "on-device" : "apple-network"]
    }

    static func result(_ transcript: String) -> [String: Any] {
        ["type": "result", "transcript": transcript, "final": true]
    }

    static func ended(_ reason: String) -> [String: Any] {
        ["type": "ended", "reason": reason]
    }
}

private func supportedLocale(_ identifier: String) -> Locale? {
    SFSpeechRecognizer.supportedLocales().first {
        localeKey($0.identifier) == localeKey(identifier)
    }
}

private func speechPermission(_ value: SFSpeechRecognizerAuthorizationStatus) -> String {
    switch value {
    case .authorized: return "authorized"
    case .denied: return "denied"
    case .restricted: return "restricted"
    case .notDetermined: return "not-determined"
    @unknown default: return "unknown"
    }
}

private func microphonePermission(_ value: AVAuthorizationStatus) -> String {
    switch value {
    case .authorized: return "authorized"
    case .denied: return "denied"
    case .restricted: return "restricted"
    case .notDetermined: return "not-determined"
    @unknown default: return "unknown"
    }
}

private func status(_ identifier: String) -> [String: Any] {
    let locale = supportedLocale(identifier)
    let recognizer = locale.flatMap { SFSpeechRecognizer(locale: $0) }
    let local = recognizer?.supportsOnDeviceRecognition ?? false
    var value: [String: Any] = [
        "supported": recognizer != nil,
        "available": recognizer?.isAvailable ?? false,
        "locale": identifier,
        "authorizationStatus": speechPermission(SFSpeechRecognizer.authorizationStatus()),
        "microphoneStatus": microphonePermission(AVCaptureDevice.authorizationStatus(for: .audio)),
        "localRecognitionAvailable": local,
        "inputAvailable": AVCaptureDevice.default(for: .audio) != nil,
        "mode": local ? "on-device" : "apple-network",
        "audioCaptureStarted": false
    ]
    if recognizer == nil {
        value["code"] = "unsupported_locale"
        value["message"] = "此 Mac 的系统语音识别不支持该语言，请更换识别语言。"
    }
    return value
}

@MainActor private final class DictationSession {
    private let locale: Locale
    private var engine: AVAudioEngine?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?
    private var recognizer: SFSpeechRecognizer?
    private var inputTapInstalled = false
    private var audioClosed = false
    private var started = false
    private var stopping = false
    private var finished = false
    private var resultEmitted = false
    private var stopReason = "stopped"
    private var timeout: Task<Void, Never>?
    private var finalTimeout: Task<Void, Never>?
    private var signalSources = [DispatchSourceSignal]()
    private var completion: CheckedContinuation<Int32, Never>?

    init(locale: Locale) { self.locale = locale }

    func run() async -> Int32 {
        await withCheckedContinuation { continuation in
            completion = continuation
            installSignals()
            readCommands()
            Task { await authorizeAndStart() }
        }
    }

    private func authorizeAndStart() async {
        guard !finished else { return }
        var microphone = AVCaptureDevice.authorizationStatus(for: .audio)
        if microphone == .notDetermined {
            _ = await withCheckedContinuation { continuation in
                AVCaptureDevice.requestAccess(for: .audio) { granted in
                    continuation.resume(returning: granted)
                }
            }
            microphone = AVCaptureDevice.authorizationStatus(for: .audio)
        }
        guard !finished else { return }
        switch microphone {
        case .authorized: break
        case .denied:
            fail(SpeechFailure("microphone_denied", "请在系统设置 → 隐私与安全性 → 麦克风中允许 CoworkOS，然后重新打开应用。"))
            return
        case .restricted:
            fail(SpeechFailure("microphone_restricted", "此设备限制了麦克风访问，请检查设备管理或家长控制设置。"))
            return
        default:
            fail(SpeechFailure("microphone_denied", "未获得麦克风授权，请重新点击麦克风并完成系统授权。"))
            return
        }

        var speech = SFSpeechRecognizer.authorizationStatus()
        if speech == .notDetermined {
            speech = await withCheckedContinuation { continuation in
                SFSpeechRecognizer.requestAuthorization { authorization in
                    continuation.resume(returning: authorization)
                }
            }
        }
        guard !finished else { return }
        switch speech {
        case .authorized: break
        case .denied:
            fail(SpeechFailure("speech_denied", "请在系统设置 → 隐私与安全性 → 语音识别中允许 CoworkOS，然后重新打开应用。"))
            return
        case .restricted:
            fail(SpeechFailure("speech_restricted", "此设备限制了语音识别，请检查设备管理或家长控制设置。"))
            return
        default:
            fail(SpeechFailure("speech_authorization_failed", "未获得系统语音识别授权，请重新点击麦克风并完成系统授权。"))
            return
        }

        guard let recognizer = SFSpeechRecognizer(locale: locale) else {
            fail(SpeechFailure("unsupported_locale", "此 Mac 不支持该识别语言，请更换语言。"))
            return
        }
        guard recognizer.isAvailable else {
            fail(SpeechFailure("recognizer_unavailable", "系统语音识别暂不可用，请检查网络及系统听写设置后重试。"))
            return
        }
        guard AVCaptureDevice.default(for: .audio) != nil else {
            fail(SpeechFailure("input_unavailable", "未找到可用麦克风，请连接麦克风并检查系统声音输入设置。"))
            return
        }

        let local = recognizer.supportsOnDeviceRecognition
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = false
        request.taskHint = .dictation
        request.requiresOnDeviceRecognition = local
        let engine = AVAudioEngine()
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            fail(SpeechFailure("input_unavailable", "麦克风没有可用音频格式，请检查系统声音输入设置后重试。"))
            return
        }
        self.recognizer = recognizer
        self.request = request
        self.engine = engine
        recognizer.queue = OperationQueue.main
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
            request.append(buffer)
        }
        inputTapInstalled = true
        recognitionTask = recognizer.recognitionTask(with: request) { [weak self] result, error in
            Task { @MainActor in
                self?.receive(result: result, error: error)
            }
        }
        do {
            engine.prepare()
            try engine.start()
        } catch {
            fail(SpeechFailure("audio_start_failed", "无法启动麦克风，请检查声音输入设备是否可用后重试。", native: error as NSError))
            return
        }
        started = true
        emit(SpeechEvent.started(locale: locale, local: local))
        timeout = Task { [weak self] in
            do { try await Task.sleep(nanoseconds: 60_000_000_000) } catch { return }
            self?.stop(reason: "limit")
        }
    }

    private func receive(result: SFSpeechRecognitionResult?, error: Error?) {
        guard !finished else { return }
        if let result, result.isFinal {
            let transcript = result.bestTranscription.formattedString.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !transcript.isEmpty else {
                fail(SpeechFailure("no_speech", "没有识别到语音，请靠近麦克风并重新试一次。"))
                return
            }
            guard transcript.utf16.count <= 16_000, transcript.utf8.count <= 64 * 1024 else {
                fail(SpeechFailure("response_limit", "本次语音文本过长，请分成较短的片段重新输入。"))
                return
            }
            if !resultEmitted {
                resultEmitted = true
                emit(SpeechEvent.result(transcript))
            }
            finish(reason: stopping ? stopReason : "completed")
            return
        }
        if let error { fail(recognitionFailure(error as NSError)) }
    }

    private func recognitionFailure(_ error: NSError) -> SpeechFailure {
        switch (error.domain, error.code) {
        case ("kLSRErrorDomain", 102):
            return SpeechFailure("assets_unavailable", "系统尚未安装此语言的识别资源，请在系统听写设置中启用该语言并完成下载后重试。", native: error)
        case ("kLSRErrorDomain", 201):
            return SpeechFailure("dictation_disabled", "系统听写已关闭，请在系统设置 → 键盘 → 听写中启用后重试。", native: error)
        case ("kAFAssistantErrorDomain", 1100):
            return SpeechFailure("recognition_busy", "系统语音识别正在处理另一项请求，请稍后重试。", native: error)
        case ("kAFAssistantErrorDomain", 1110):
            return SpeechFailure("no_speech", "没有识别到语音，请靠近麦克风并重新试一次。", native: error)
        case ("kAFAssistantErrorDomain", 1700):
            return SpeechFailure("speech_authorization_failed", "系统未允许本次语音识别，请检查语音识别授权及系统听写设置后重试。", native: error)
        case (NSURLErrorDomain, _):
            return SpeechFailure("network_unavailable", "Apple 系统语音识别的网络连接失败，请检查网络后重试。", native: error)
        default:
            return SpeechFailure("recognition_failed", "系统语音识别失败，请检查系统听写和网络状态后重试。", native: error)
        }
    }

    private func closeAudio() {
        guard !audioClosed else { return }
        audioClosed = true
        engine?.stop()
        if inputTapInstalled {
            engine?.inputNode.removeTap(onBus: 0)
            inputTapInstalled = false
        }
        request?.endAudio()
    }

    private func stop(reason: String = "stopped") {
        guard !finished, !stopping else { return }
        guard started else {
            finish(reason: reason)
            return
        }
        stopping = true
        stopReason = reason
        timeout?.cancel()
        closeAudio()
        finalTimeout = Task { [weak self] in
            do { try await Task.sleep(nanoseconds: 5_000_000_000) } catch { return }
            self?.fail(SpeechFailure("recognition_timeout", "系统未及时返回识别结果，请分成较短的片段重新输入。"))
        }
    }

    private func fail(_ error: SpeechFailure) {
        guard !finished else { return }
        emit(error.event)
        finish(reason: "error", exitCode: 1)
    }

    private func finish(reason: String, exitCode: Int32 = 0) {
        guard !finished else { return }
        finished = true
        timeout?.cancel()
        finalTimeout?.cancel()
        closeAudio()
        recognitionTask?.cancel()
        recognitionTask = nil
        request = nil
        engine = nil
        recognizer = nil
        for source in signalSources { source.cancel() }
        signalSources.removeAll()
        emit(SpeechEvent.ended(reason))
        completion?.resume(returning: exitCode)
        completion = nil
    }

    private func installSignals() {
        for number in [SIGINT, SIGTERM] {
            signal(number, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: number, queue: .main)
            source.setEventHandler { [weak self] in
                Task { @MainActor in self?.finish(reason: "cancelled") }
            }
            source.resume()
            signalSources.append(source)
        }
    }

    private func command(_ value: String) {
        guard !finished else { return }
        switch value {
        case "stop": stop()
        case "cancel": finish(reason: "cancelled")
        default:
            fail(SpeechFailure("invalid_command", "语音输入控制命令无效，请重新启动语音输入。"))
        }
    }

    private func readCommands() {
        // Read a bounded line on a worker queue; never block the recognizer's main queue.
        DispatchQueue.global(qos: .utility).async { [weak self] in
            var buffer = [UInt8](repeating: 0, count: 256)
            var line = [UInt8]()
            var stopped = false
            while true {
                let count = buffer.withUnsafeMutableBytes {
                    Darwin.read(STDIN_FILENO, $0.baseAddress, $0.count)
                }
                if count < 0, errno == EINTR { continue }
                if count <= 0 {
                    // Closing stdin after stop is a normal half-close, not cancellation.
                    if !stopped {
                        Task { @MainActor in self?.finish(reason: "cancelled") }
                    }
                    return
                }
                for byte in buffer.prefix(count) {
                    if byte == 0x0a {
                        let value = String(bytes: line, encoding: .utf8)?
                            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                        line.removeAll(keepingCapacity: true)
                        stopped = stopped || value == "stop"
                        Task { @MainActor in self?.command(value) }
                        if value == "cancel" { return }
                    } else {
                        line.append(byte)
                        if line.count > 128 {
                            Task { @MainActor in self?.command("") }
                            return
                        }
                    }
                }
            }
        }
    }
}

@main @MainActor private struct SpeechInput {
    static func main() async {
        signal(SIGPIPE, SIG_IGN)
        #if SPEECH_PROTOCOL_TEST
        // Compile-only fixture: exercise the exact wire events without querying
        // permissions, creating a recognizer, or instantiating an audio engine.
        let failure = CommandLine.arguments.contains("--error")
        emit(SpeechEvent.started(locale: Locale(identifier: "zh-CN"),
                                 local: !CommandLine.arguments.contains("--network")))
        if failure {
            emit(SpeechFailure("no_speech", "没有识别到语音，请重新试一次。").event)
        } else {
            emit(SpeechEvent.result("协议测试，中文和 emoji 🎙️。"))
        }
        emit(SpeechEvent.ended(failure ? "error" : "completed"))
        #else
        let options: Options
        do { options = try Options.parse(Array(CommandLine.arguments.dropFirst())) }
        catch {
            emit(SpeechFailure.arguments.event)
            emit(SpeechEvent.ended("error"))
            exit(2)
        }
        if options.status {
            emit(status(options.locale))
            return
        }
        guard let locale = supportedLocale(options.locale) else {
            emit(SpeechFailure("unsupported_locale", "此 Mac 不支持该识别语言，请更换语言。").event)
            emit(SpeechEvent.ended("error"))
            exit(1)
        }
        let session = DictationSession(locale: locale)
        exit(await session.run())
        #endif
    }
}
