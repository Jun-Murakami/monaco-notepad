import ExpoModulesCore
import UIKit

public class MonacoCaretPositionModule: Module {
  /// UITextView が編集を開始したらキャッシュする。
  /// Fabric (New Architecture) では findView(withTag:) が動作しないため、
  /// UITextView.textDidBeginEditingNotification 経由で参照を取得する。
  private weak var activeTextView: UITextView?
  private var editingObserver: NSObjectProtocol?

  public func definition() -> ModuleDefinition {
    Name("MonacoCaretPosition")

    OnCreate {
      self.editingObserver = NotificationCenter.default.addObserver(
        forName: UITextView.textDidBeginEditingNotification,
        object: nil,
        queue: .main
      ) { [weak self] notification in
        if let textView = notification.object as? UITextView {
          self?.activeTextView = textView
        }
      }
    }

    OnDestroy {
      if let observer = self.editingObserver {
        NotificationCenter.default.removeObserver(observer)
      }
    }

    AsyncFunction("getCaretRect") { (reactTag: Int, offset: Int) -> [String: Double]? in
      guard let textView = self.activeTextView else { return nil }

      let textLength = textView.text?.utf16.count ?? 0
      let safeOffset = min(max(offset, 0), textLength)
      guard let position = textView.position(from: textView.beginningOfDocument, offset: safeOffset) else {
        return nil
      }

      let rect = textView.caretRect(for: position)
      return [
        "x": Double(rect.origin.x),
        "y": Double(rect.origin.y),
        "width": Double(rect.width),
        "height": Double(rect.height),
      ]
    }
    .runOnQueue(.main)

    // focus 前に呼ぶ。UITextView の scrollEnabled を一時的に false にして、
    // becomeFirstResponder 時の scrollRangeToVisible 自動スクロールを抑制する。
    // scrollCaretToVisibleCenter が true に戻すので、ペアで使うこと。
    // activeTextView がまだキャッシュされていない場合は何もしない (best-effort)。
    AsyncFunction("suppressAutoScroll") { (reactTag: Int) -> Bool in
      guard let textView = self.activeTextView else { return false }
      textView.isScrollEnabled = false
      return true
    }
    .runOnQueue(.main)

    AsyncFunction("scrollCaretToVisibleCenter") { (reactTag: Int, offset: Int, visibleHeight: Double, bottomInset: Double, animated: Bool) -> Bool in
      guard let textView = self.activeTextView else { return false }

      let textLength = textView.text?.utf16.count ?? 0
      let safeOffset = min(max(offset, 0), textLength)
      guard let position = textView.position(from: textView.beginningOfDocument, offset: safeOffset) else {
        return false
      }

      let rect = textView.caretRect(for: position)
      textView.contentInset.bottom = max(0, bottomInset)
      textView.scrollIndicatorInsets.bottom = max(0, bottomInset)

      let effectiveVisibleHeight = max(rect.height, visibleHeight)
      let caretContentY = rect.origin.y
      let lineHeight = max(rect.height, textView.font?.lineHeight ?? rect.height)
      let targetY = caretContentY - effectiveVisibleHeight / 2 + lineHeight
      // JS 側から渡された可視領域高さで maxY を算出する。
      // textView.bounds.height は Reanimated のアニメーション中にキーボード分の
      // 縮小を反映しないことがあるため使用しない。
      let maxY = max(0, textView.contentSize.height - effectiveVisibleHeight)
      let clampedY = min(max(0, targetY), maxY)

      // suppressAutoScroll で無効化されていた場合はここで復元する。
      if !textView.isScrollEnabled {
        textView.isScrollEnabled = true
      }
      textView.setContentOffset(CGPoint(x: 0, y: clampedY), animated: false)
      // UIKit の scrollRangeToVisible 自動スクロールを上書きするため、遅延再適用。
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak textView] in
        guard let tv = textView else { return }
        tv.setContentOffset(CGPoint(x: 0, y: clampedY), animated: animated)
      }
      return true
    }
    .runOnQueue(.main)
  }
}
