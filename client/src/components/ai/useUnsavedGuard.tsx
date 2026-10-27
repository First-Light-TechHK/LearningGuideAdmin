import { App, Button } from '../ui'
import { useAiText } from './i18n'
import { useAiStore } from '../../stores/aiStore'

/**
 * 未保存改动提醒（§4.3.6，2026-10-20 新增）。
 *
 * 返回 `guard()`，供「会丢弃配置面板未保存改动」的操作在真正执行前调用：
 * - 无未保存改动 → 直接 resolve(true)（无需弹窗）；
 * - 有未保存改动 → 弹窗（保存 / 不保存 / 取消）：
 *   - **保存**：执行 Save Configuration（写当前模式），成功 → true；失败 → false（中止原操作并提示错误）；
 *   - **不保存**：丢弃改动 → true（继续执行原操作）；
 *   - **取消**（含 ESC / 关闭）：留在当前页 → false，不切换（QA 2026-10-27 A14：与按钮文案一致）。
 *
 * 触发场景：切换编辑模式、切换课程（Change Course）、切换 Release 版本。
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
      const dialog = modal.confirm({
        title: text('unsavedTitle'),
        content: text('unsavedContent'),
        okText: text('unsavedSave'),
        cancelText: text('unsavedStay'),
        footer: (_, { OkBtn, CancelBtn }) => (
          <>
            <Button
              onClick={() => {
                dialog.destroy()
                resolve(true)
              }}
            >
              {text('unsavedDiscard')}
            </Button>
            <CancelBtn />
            <OkBtn />
          </>
        ),
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
