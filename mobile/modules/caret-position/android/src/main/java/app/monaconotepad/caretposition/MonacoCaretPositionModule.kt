package app.monaconotepad.caretposition

import android.widget.EditText
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class MonacoCaretPositionModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("MonacoCaretPosition")

    AsyncFunction("getCaretRect") { reactTag: Int, offset: Int ->
      val editText = appContext.findView<EditText>(reactTag) ?: return@AsyncFunction null
      val layout = editText.layout ?: return@AsyncFunction null
      val safeOffset = offset.coerceIn(0, editText.text?.length ?: 0)
      val line = layout.getLineForOffset(safeOffset)
      val lineTop = layout.getLineTop(line).toFloat()
      val lineBottom = layout.getLineBottom(line).toFloat()
      val density = editText.resources.displayMetrics.density

      // ReactEditText の Layout は本文領域の座標を返す。padding を足すと、
      // TextInput コンテンツ内座標になる。Android native は px、React Native JS は
      // dp を期待するため、density で割ってから返す。
      mapOf(
        "x" to ((layout.getPrimaryHorizontal(safeOffset) + editText.totalPaddingLeft - editText.scrollX) / density).toDouble(),
        "y" to ((lineTop + editText.totalPaddingTop) / density).toDouble(),
        "width" to (1.0 / density),
        "height" to ((lineBottom - lineTop) / density).toDouble(),
      )
    }.runOnQueue(Queues.MAIN)
  }
}
