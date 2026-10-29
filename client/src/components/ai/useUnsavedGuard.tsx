import { App } from '../ui'
import { useAiText } from './i18n'
import { useAiStore } from '../../stores/aiStore'

/**
 * 未保存改动提醒（§4.3.6，2026-10-20 新增；2026-10-29 简化为二选一：保存 / 取消）。
 *
 * 返回 `guard()`，供「会丢弃配置面板未保存改动」的操作在真正执行前调用：
 * - 无未保存改动 → 直接 resolve(true)（无需弹窗）；
 * - 有未保存改动 → 弹窗（保存 / 取消）：
 *   - **保存**：执行 Save Configuration（写当前模式），成功 → true；失败 → false（中止原操作并提示错误）；
 *   - **取消**（含 ESC / 关闭）：留在当前页 → false，不切换。
 *
 * 触发场景：切换编辑模式、切换课程（Change Course）、切换 Release 版本。
 *
 * 2026-10-29：删除了原来的「不保存」按钮。用户如需放弃改动，可先 Reset 再切换；
 * 或直接点取消留在当前页。避免用户误点「不保存」丢失已编辑的提示词内容。
 */
export function useUnsavedGuard(): () => Promise<boolean> {
  const { message, modal } = App.useApp()
  const save = useAiStore((s) => s.save)
  const { text } = useAiText()

  return () =>
    new Promise<boolean>((resolve) => {
      if (!useAiStore.getState().isDirty()) {
        resolve(true)
        return
      }
      modal.confirm({
        title: text('unsavedTitle'),
        content: text('unsavedContent'),
        okText: text('unsavedSave'),
        cancelText: text('unsavedStay'),
        onOk: async () => {
          // 保存失败（如后端校验错误）→ 显式提示并返回 false 中止原操作
          const ok = await save()
          if (!ok) {
            message.error(useAiStore.getState().error ?? text('saveFailed'))
          }
          resolve(ok)
        },
        onCancel: () => resolve(false),
      })
    })
}
