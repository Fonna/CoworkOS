import AppKit
import Foundation

// macOS displays the supplied alpha silhouette; it does not round a square PNG for us.
// Keep the existing mark as the artwork and give it a separate, inset app-icon tile.
guard CommandLine.arguments.count == 3,
      let artwork = NSImage(contentsOfFile: CommandLine.arguments[1]),
      let image = artwork.cgImage(forProposedRect: nil, context: nil, hints: nil),
      let context = CGContext(
        data: nil, width: 1024, height: 1024, bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpace(name: CGColorSpace.sRGB)!,
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
      ) else {
    fatalError("Unable to load CoworkOS artwork or create the icon canvas")
}

context.setAllowsAntialiasing(true)
context.setShouldAntialias(true)
let tile = CGPath(
    roundedRect: CGRect(x: 96, y: 96, width: 832, height: 832),
    cornerWidth: 184, cornerHeight: 184, transform: nil
)
context.saveGState()
context.setShadow(
    offset: CGSize(width: 0, height: -12), blur: 26,
    color: CGColor(srgbRed: 0.08, green: 0.10, blue: 0.18, alpha: 0.16)
)
context.addPath(tile)
context.setFillColor(CGColor(srgbRed: 1, green: 1, blue: 1, alpha: 1))
context.fillPath()
context.restoreGState()

context.saveGState()
context.addPath(tile)
context.clip()
let gradient = CGGradient(
    colorsSpace: CGColorSpace(name: CGColorSpace.sRGB),
    colors: [
        CGColor(srgbRed: 0.96, green: 0.97, blue: 0.99, alpha: 1),
        CGColor(srgbRed: 1, green: 1, blue: 1, alpha: 1)
    ] as CFArray,
    locations: [0, 1]
)!
context.drawLinearGradient(
    gradient, start: CGPoint(x: 512, y: 96), end: CGPoint(x: 512, y: 928), options: []
)

let width: CGFloat = 684
let height = width * CGFloat(image.height) / CGFloat(image.width)
context.interpolationQuality = .high
context.draw(image, in: CGRect(x: (1024 - width) / 2, y: (1024 - height) / 2, width: width, height: height))
context.restoreGState()

guard let rendered = context.makeImage(),
      let png = NSBitmapImageRep(cgImage: rendered).representation(using: .png, properties: [:]) else {
    fatalError("Unable to encode the CoworkOS app icon")
}
try png.write(to: URL(fileURLWithPath: CommandLine.arguments[2]), options: .atomic)
