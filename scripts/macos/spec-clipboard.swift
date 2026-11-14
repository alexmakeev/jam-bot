// Read only the file URL advertised by Finder. Never inspect unrelated clipboard contents.
import AppKit
import Foundation

let board = NSPasteboard.general
let count = board.changeCount
guard CommandLine.arguments.count == 2,
      let items = board.pasteboardItems, items.count == 1,
      let value = items[0].string(forType: .fileURL),
      let selected = URL(string: value), selected.isFileURL,
      selected.resolvingSymlinksInPath().path == URL(fileURLWithPath: CommandLine.arguments[1]).resolvingSymlinksInPath().path,
      board.changeCount == count else {
    fputs("Clipboard does not hold the expected single specification.\n", stderr)
    exit(1)
}
