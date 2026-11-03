import AppKit
import Darwin
import Foundation

// Diagnostic SPI is confined to this test fixture; the launcher uses LaunchServices.
typealias ResponsiblePID = @convention(c) (pid_t) -> pid_t
let library = dlopen(nil, RTLD_NOW)!
let responsible = unsafeBitCast(dlsym(library, "responsibility_get_pid_responsible_for_pid")!, to: ResponsiblePID.self)

NSApplication.shared.setActivationPolicy(.prohibited)
var report: [String: Any] = ["pid": Int(getpid()), "responsiblePid": Int(responsible(getpid()))]
if CommandLine.arguments[1] != "--child" {
    let child = Process()
    child.executableURL = URL(fileURLWithPath: CommandLine.arguments[0])
    child.arguments = ["--child"]
    let pipe = Pipe()
    child.standardOutput = pipe
    try child.run()
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    child.waitUntilExit()
    guard child.terminationStatus == 0 else { exit(1) }
    report["child"] = try JSONSerialization.jsonObject(with: data)
    report["marker"] = ProcessInfo.processInfo.environment["ATRIA_LAUNCH_FIXTURE_MARKER"] ?? ""
    report["data"] = ProcessInfo.processInfo.environment["COWORK_DESKTOP_DATA"] ?? ""
    report["arguments"] = Array(CommandLine.arguments.dropFirst(2))
    let reportPath = ProcessInfo.processInfo.environment["ATRIA_LAUNCH_FIXTURE_REPORT"] ?? CommandLine.arguments[1]
    try JSONSerialization.data(withJSONObject: report).write(to: URL(fileURLWithPath: reportPath), options: .atomic)
} else {
    FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: report))
}
